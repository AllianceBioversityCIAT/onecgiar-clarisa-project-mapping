Now I'll produce the full implementation plan.

---

# PRMS Projects Registry — Full Implementation Plan

## Pre-Plan: Assumptions Documented

Before the task breakdown, these assumptions are explicit and should be validated:

1. **CONFIRMED: Roles managed internally** — Cognito is auth-only (login/tokens). Roles (`admin`, `program_rep`, `center_rep`) are stored in our DB and assigned by admin via Users Management page. No `custom:role` Cognito claims.
2. **CLARISA sync is read-only cache**: We pull Centers, Programs (Initiatives), Countries, and Action Areas from CLARISA and cache them locally. We do not write back to CLARISA.
3. **CONFIRMED: One Center Rep per Center**: A Center Representative is associated with exactly one CGIAR Center. No multi-user sharing.
4. **One Program Rep per Program**: A Program Representative is associated with exactly one Initiative/Program. They can only map projects to their own program.
5. **CONFIRMED: Allocation must = 100% before center review**: Center reps can ONLY review mappings once the project's total allocation reaches 100%. No partial review.
5a. **CONFIRMED: Rejection allows resubmission**: Program reps can edit rejected mappings, status goes back to `pending`. Rejection reason preserved.
5b. **CONFIRMED: Project code is a separate field**: CSV codes like `S0003`, `T-PJ-004023` stored as a `code` column distinct from `name`.
6. **Source of funding normalization**: The CSV has inconsistent values (`Window 3`, `W3`, `WINDOW 3 - RESTRICTED`, etc.). These will be normalized to an enum at import time.
7. **CSV import is a one-time admin tool**, not a recurring job. It runs once to seed production data.
8. **No real-time features**: No WebSockets. Status changes trigger email notifications in a future phase (out of scope here).

---

## Database Schema Design

This is the conceptual schema all waves build against. The backend agent will implement it as TypeORM entities + migrations.

```
users
  id (PK), cognito_sub (unique), email, first_name, last_name,
  role (enum: admin|program_rep|center_rep, default: null — assigned by admin),
  program_id (FK -> programs, nullable), center_id (FK -> centers, nullable),
  is_active, created_at, updated_at
  NOTE: Role is NOT from Cognito claims — admin assigns roles via Users page

centers  [seeded from CLARISA]
  id (PK), clarisa_id (unique), code, name, acronym, institution_id

programs  [seeded from CLARISA — initiatives endpoint]
  id (PK), clarisa_id (unique), official_code, name

countries  [seeded from CLARISA]
  id (PK), clarisa_id (unique), iso_alpha2, iso_alpha3, name, region

action_areas  [seeded from CLARISA]
  id (PK), clarisa_id (unique), name, description, color

projects
  id (PK), code (unique, varchar — e.g. 'S0003', 'T-PJ-004023'),
  name, description, summary, results,
  start_date, end_date,
  total_budget (decimal 10,2), remaining_budget (decimal 10,2),
  center_id (FK -> centers),
  funding_source (enum: window3|bilateral|srv|other),
  funder (varchar),
  status (enum: draft|active|archived),
  created_by (FK -> users), created_at, updated_at

project_countries  [join table]
  project_id (FK), country_id (FK)

project_mappings  [the core workflow entity]
  id (PK),
  project_id (FK -> projects),
  program_id (FK -> programs),
  allocation_percentage (decimal 5,2),  -- e.g. 50.00 for 50%
  complementarity_rating (enum: high|medium|low, nullable),
  efficiency_rating (enum: high|medium|low, nullable),
  status (enum: pending|approved|rejected),
  rejection_reason (text, nullable),
  submitted_by (FK -> users),
  reviewed_by (FK -> users, nullable),
  submitted_at, reviewed_at,
  created_at, updated_at
  UNIQUE (project_id, program_id)
```

Key constraint: `SUM(allocation_percentage) WHERE project_id = X` must equal 100 when all mappings are approved. Enforced at application layer, not DB constraint (to allow partial workflow states).

---

## Wave Structure Overview

| Wave | Theme | Duration Estimate | Parallelizable? |
|------|-------|-------------------|-----------------|
| Wave 1 | Foundation & Auth | 3–4 days | BE + FE in parallel after API contract defined |
| Wave 2 | CLARISA Sync & Reference Data | 2–3 days | BE-only (no FE needed yet) |
| Wave 3 | Project CRUD (Admin) | 4–5 days | BE + FE in parallel |
| Wave 4 | Program Mapping Workflow | 4–5 days | BE + FE in parallel |
| Wave 5 | Center Approval Workflow | 3–4 days | BE + FE in parallel |
| Wave 6 | CSV Import | 2 days | BE-only |
| Wave 7 | Dashboard & Reporting | 3–4 days | BE + FE in parallel |
| Wave 8 | QA Hardening & Polish | 2–3 days | All agents |

**Total estimate: 23–31 development days** (assumes one developer per agent lane)

---

## Wave 1 — Foundation & Auth

**Goal**: A running API with authentication, global infrastructure (pipes, filters, interceptors, CORS, Swagger), and an Angular shell with Cognito OAuth2 flow, routing, role guards, and layout.

**API Contract for FE**: After Wave 1, the frontend can call `GET /api/auth/me` with a Bearer token and receive `{ id, email, firstName, lastName, role, programId, centerId }`.

---

### BE-1.1 — Bootstrap API Infrastructure

**Layer**: Backend
**Complexity**: M

**Description**: Harden `main.ts` and global infrastructure that all future modules depend on. The scaffolded `main.ts` is minimal — this task adds everything required for production-quality operation.

**Acceptance Criteria**:
- `ValidationPipe` registered globally with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`
- `AllExceptionsFilter` registered globally — catches all unhandled errors, logs via NestJS `Logger`, returns structured `{ statusCode, message, timestamp, path }` JSON
- CORS enabled for `CORS_ORIGIN` env var (reads from app config)
- Swagger (`@nestjs/swagger`) mounted at `/api/docs` in non-production environments, with Bearer auth scheme configured
- Winston logger wired via `app.useLogger()` — reads `LOG_LEVEL` and `LOG_FORMAT` from config
- Request ID interceptor (UUID per request, sets `X-Request-ID` response header, stored in `AsyncLocalStorage`)
- HTTP request logging interceptor (method, path, status, duration) writing to `http-*.log`
- `app.setGlobalPrefix('api')` set
- Health check endpoint `GET /api/health` returning `{ status: 'ok', timestamp }` — no auth required
- All new code has JSDoc comments on classes and methods

**Technical Notes**:
- Install `@nestjs/swagger` if not present (check `package.json` first)
- The `common/` directory has placeholder subdirectories — populate them: `filters/all-exceptions.filter.ts`, `interceptors/request-id.interceptor.ts`, `interceptors/logging.interceptor.ts`, `logger/winston.logger.ts`
- `AsyncLocalStorage` instance should be a singleton provider exported from a `RequestContextModule`

**Dependencies**: None (first task)

---

### BE-1.2 — Base Entity & User Entity + Migration

**Layer**: Backend / Database
**Complexity**: S

**Description**: Create a `BaseEntity` with shared audit columns, then create the `User` entity and its migration.

**Acceptance Criteria**:
- `common/entities/base.entity.ts` — abstract class with `id` (PK, uuid default), `createdAt`, `updatedAt` (TypeORM `@CreateDateColumn`, `@UpdateDateColumn`)
- `User` entity at `modules/users/user.entity.ts` with columns: `cognitoSub` (unique, varchar), `email` (unique), `firstName`, `lastName`, `role` (enum: `admin|program_rep|center_rep`), `programId` (nullable uuid FK placeholder — actual FK added in Wave 2 migration), `centerId` (nullable uuid FK placeholder), `isActive` (default true)
- TypeORM migration generated and verified: `CreateUsersTable`
- `UsersModule` with `UsersService` exposing `findByCognitoSub(sub: string)`, `findById(id: string)`, `upsertFromCognito(payload: CognitoPayload)` — upsert creates or updates based on `cognitoSub`
- All methods have JSDoc

**Dependencies**: BE-1.1

---

### BE-1.3 — Cognito Auth Module

**Layer**: Backend
**Complexity**: L

**Description**: Implement the Cognito OAuth2 authorization code flow on the backend. The Angular app redirects the user to Cognito, receives an auth code, POSTs it to the API which exchanges it for tokens and sets an httpOnly refresh cookie.

**Acceptance Criteria**:
- `AuthModule` at `modules/auth/`
- `GET /api/auth/login` — returns the Cognito authorization URL (constructs it from config: domain, client_id, redirect_uri, scope=openid+email+profile)
- `POST /api/auth/callback` — accepts `{ code: string }`, exchanges with Cognito token endpoint (`/oauth2/token`), validates the ID token (JWT verify using Cognito JWKS), upserts user via `UsersService.upsertFromCognito()`, returns `{ accessToken, user }` and sets `refreshToken` as httpOnly cookie (30d expiry, sameSite: strict, secure in prod)
- `POST /api/auth/refresh` — reads refresh cookie, calls Cognito `/oauth2/token` with grant_type=refresh_token, returns new access token
- `POST /api/auth/logout` — clears the refresh cookie, optionally calls Cognito `/oauth2/revoke`
- `GET /api/auth/me` — protected by JWT guard, returns current user object
- `JwtStrategy` validates Bearer token, calls `UsersService.findByCognitoSub()`, attaches user to request
- `JwtAuthGuard` implemented and globally registered as default — endpoints that skip auth use `@Public()` decorator
- `RolesGuard` implemented — `@Roles('admin')` decorator restricts access by role
- All auth errors return appropriate HTTP status codes (401 for invalid token, 403 for insufficient role)
- Typed config for Cognito added to `auth.config.ts`: `cognitoApi`, `cognitoClientId`, `cognitoClientSecret`, `cognitoRedirectUri`

**Technical Notes**:
- Install `jwks-rsa` for JWKS validation OR use `passport-jwt` with a custom JWKS fetcher
- Cognito JWKS URL: `{cognitoApi}/.well-known/jwks.json`
- The `custom:role` claim in the Cognito ID token determines the user's role. Document this assumption clearly — if Cognito is not configured with custom attributes, a fallback to a local roles table is needed
- `HttpModule` from `@nestjs/axios` for token exchange HTTP calls

**Dependencies**: BE-1.1, BE-1.2

---

### FE-1.1 — Angular Shell: Layout, Routing, and Theme

**Layer**: Frontend
**Complexity**: M

**Description**: Set up the Angular application shell: routing structure, layout with PrimeNG sidebar + toolbar, PRMS theme, and route-level lazy loading scaffolding.

**Acceptance Criteria**:
- `app.routes.ts` defines top-level routes: `/auth` (public), `/` -> redirects to `/dashboard`, all other routes lazy-load feature modules under `LayoutComponent`
- `LayoutComponent` (`layout/`) renders: left sidebar with navigation links (Dashboard, Projects, Mappings, Users [admin only]), top toolbar with user avatar + logout button, `<router-outlet>` for content
- PrimeNG Aura preset configured in `app.config.ts` with PRMS design tokens: primary color `#eb2f64`, font Poppins
- Global SCSS sets up Poppins import (Google Fonts or local), base typography and reset — matches CLAUDE.md theme spec
- `polyfills: ["zone.js"]` confirmed in `angular.json` build options
- Responsive: sidebar collapses to icon-only on screens < 1024px with a hamburger toggle
- Active route highlighted in sidebar navigation
- Each feature area has a placeholder route + "coming soon" page so navigation works end-to-end before features are built

**Technical Notes**:
- Use `PrimeSidebar` or a custom sidebar using PrimeNG `PanelMenu` for nav items
- Design tokens applied via `providePrimeNG({ theme: { preset: Aura, options: { ... } } })` in `app.config.ts`
- No Angular Material — PrimeNG only

**Dependencies**: None

---

### FE-1.2 — Cognito OAuth2 Flow in Angular

**Layer**: Frontend
**Complexity**: M

**Description**: Implement the complete auth flow: redirect to Cognito login, handle the callback, store access token, attach it to API requests, and guard protected routes.

**Acceptance Criteria**:
- `AuthService` (`core/services/auth.service.ts`): signal-based `currentUser` signal, `login()` calls `GET /api/auth/login` and redirects browser to Cognito URL, `handleCallback(code)` POSTs code to `POST /api/auth/callback`, stores access token in memory (not localStorage), `logout()` calls `POST /api/auth/logout` and clears state, `refreshToken()` calls `POST /api/auth/refresh`
- `/auth` route component handles the `?code=` query param on load and calls `AuthService.handleCallback(code)`, then redirects to `/dashboard`
- `AuthInterceptor` (`core/interceptors/`) attaches `Authorization: Bearer {token}` to all requests to the API domain
- `AuthGuard` (`core/guards/`) protects all non-public routes — redirects to Cognito login if no token
- `RoleGuard` (`core/guards/`) accepts required roles, reads `currentUser().role`, returns 403/redirect if insufficient
- `ApiService` (`core/services/`) is a typed wrapper around `HttpClient` with base URL from `environment.apiUrl` — all feature services extend or inject this
- Token stored in memory (Angular signal/service), not localStorage — on page refresh, attempt token refresh via cookie before redirecting to login
- Loading state shown during the callback redirect (PrimeNG `ProgressSpinner`)

**Technical Notes**:
- Access token lives in an Angular Signal within `AuthService` — never written to localStorage or sessionStorage
- The httpOnly refresh cookie is set by the API — Angular does not manage it directly, just calls the refresh endpoint
- `environment.ts` defines `apiUrl: 'http://localhost:3000'` (dev) and production equivalent

**Dependencies**: FE-1.1, BE-1.3 (can develop against mock before BE is ready)

---

## Wave 2 — CLARISA Sync & Reference Data

**Goal**: Populate local database with Centers, Programs, Countries, and Action Areas from CLARISA. Expose reference data endpoints the frontend will use for dropdowns. This wave is entirely backend.

**Note**: No frontend tasks in Wave 2. The FE can proceed to Wave 3 frontend tasks in parallel once Wave 1 is complete, using hardcoded/mock reference data that gets replaced when Wave 2 is wired.

---

### BE-2.1 — CLARISA HTTP Client Module

**Layer**: Backend
**Complexity**: S

**Description**: Create a shared `ClarisaModule` that provides a typed HTTP client for the CLARISA API with basic auth, error handling, and retry logic.

**Acceptance Criteria**:
- `modules/clarisa/clarisa.module.ts` — global module, exports `ClarisaService`
- `ClarisaService` uses `HttpService` (`@nestjs/axios`) with base URL from config, basic auth headers from `CLARISA_USERNAME` / `CLARISA_PASSWORD`
- Methods: `getCenters()`, `getPrograms()`, `getCountries()`, `getActionAreas()` — each returns typed DTOs matching CLARISA response shapes
- On HTTP error (network, 4xx, 5xx), logs the error with request context and throws a descriptive `ServiceUnavailableException`
- Response types defined as interfaces in `modules/clarisa/interfaces/`
- `clarisa.config.ts` typed config: `clarisaUrl`, `clarisaUsername`, `clarisaPassword`

**Technical Notes**:
- Add `ClarisaConfig` to the `ConfigModule.forRoot` load array in `AppModule`
- Use `firstValueFrom()` to convert Observable to Promise in service methods
- No caching at this layer — caching is handled by the sync service

**Dependencies**: BE-1.1

---

### BE-2.2 — Reference Data Entities + Migrations

**Layer**: Backend / Database
**Complexity**: M

**Description**: Create TypeORM entities and migrations for Centers, Programs (Initiatives), Countries, and Action Areas.

**Acceptance Criteria**:
- Entities created at `modules/reference-data/entities/`:
  - `center.entity.ts`: `id`, `clarisaId` (unique int), `code`, `name`, `acronym`, `institutionId`, `syncedAt`
  - `program.entity.ts`: `id`, `clarisaId` (unique int), `officialCode`, `name`, `syncedAt`
  - `country.entity.ts`: `id`, `clarisaId` (unique int), `isoAlpha2`, `isoAlpha3`, `name`, `region`, `syncedAt`
  - `action_area.entity.ts`: `id`, `clarisaId` (unique int), `name`, `description`, `color`, `syncedAt`
- Add FK columns to `users` table: `programId` references `programs.id`, `centerId` references `centers.id` — via a new migration (`AddForeignKeysToUsers`)
- Migrations generated and idempotent (use `upsert` / `INSERT ... ON DUPLICATE KEY UPDATE` logic in seed, not in migration DDL)

**Dependencies**: BE-1.2, BE-2.1

---

### BE-2.3 — CLARISA Sync Service + Admin Trigger Endpoint

**Layer**: Backend
**Complexity**: M

**Description**: Implement the sync logic that fetches from CLARISA and upserts into local tables. Expose a protected admin endpoint to trigger sync on demand.

**Acceptance Criteria**:
- `ReferenceDataService` in `modules/reference-data/` with `syncAll()` method that calls all four CLARISA endpoints and upserts into local tables using TypeORM `save()` with conflict resolution on `clarisaId`
- `syncAll()` runs on application startup (use `OnApplicationBootstrap` lifecycle hook) if local tables are empty
- `POST /api/admin/sync-clarisa` — admin-only (JWT + Roles guard), triggers `syncAll()`, returns `{ synced: { centers: N, programs: N, countries: N, actionAreas: N } }`
- Sync logs each entity type count at `info` level via NestJS Logger
- On individual entity sync failure, logs the error and continues (partial sync is acceptable)

**Dependencies**: BE-2.2

---

### BE-2.4 — Reference Data REST Endpoints

**Layer**: Backend
**Complexity**: S

**Description**: Expose read-only endpoints for all reference data. These are used by the frontend for dropdown population.

**Acceptance Criteria**:
- `GET /api/centers` — returns all centers, sorted by name. Response: `{ id, clarisaId, code, name, acronym }[]`
- `GET /api/programs` — returns all programs, sorted by name. Response: `{ id, clarisaId, officialCode, name }[]`
- `GET /api/countries` — returns all countries, sorted by name. Response: `{ id, clarisaId, isoAlpha2, isoAlpha3, name, region }[]`
- `GET /api/action-areas` — returns all action areas. Response: `{ id, clarisaId, name, description, color }[]`
- All endpoints protected by JWT (any authenticated user can read)
- Responses are cached in memory for 5 minutes using a simple Map-based cache in the service (no Redis needed at this scale)

**Dependencies**: BE-2.3

---

## Wave 3 — Project CRUD (Admin)

**Goal**: Admin can create, read, update, archive, and search projects. Program Reps and Center Reps can list and view projects (read-only). This is the core registry.

**Parallelism**: BE-3.1 through BE-3.3 can run in parallel with FE-3.1 through FE-3.3 once the API contract below is agreed.

**API Contract**:
```
GET    /api/projects              (paginated list, filters)
GET    /api/projects/:id          (single project with mappings summary)
POST   /api/projects              (admin only)
PATCH  /api/projects/:id          (admin only)
DELETE /api/projects/:id          (admin only — soft delete/archive)
```

---

### BE-3.1 — Project Entity + Migration

**Layer**: Backend / Database
**Complexity**: M

**Description**: Create the `Project` entity and `ProjectCountry` join table with all columns per the schema design.

**Acceptance Criteria**:
- `project.entity.ts` with all fields: `name`, `description`, `summary`, `results`, `startDate`, `endDate`, `totalBudget` (decimal 10,2), `remainingBudget` (decimal 10,2), `fundingSource` (enum: `window3|bilateral|srv|other`), `funder`, `status` (enum: `draft|active|archived`, default `active`), `centerId` (FK -> centers), `createdBy` (FK -> users)
- `ManyToMany` relation to `Country` via `project_countries` join table
- All relations are lazy-loaded (use eager only where explicitly needed)
- Migration `CreateProjectsTable` generated and working
- `Project` entity re-exported from `ProjectsModule`

**Dependencies**: BE-2.2

---

### BE-3.2 — Projects Service & DTOs

**Layer**: Backend
**Complexity**: M

**Description**: Implement the data access layer for projects with full CRUD, search, and pagination.

**Acceptance Criteria**:
- `CreateProjectDto`: all required project fields, `countryIds: string[]`, `class-validator` decorators on all fields (IsString, IsDate, IsDecimal etc.), transformers for date strings
- `UpdateProjectDto`: extends `PartialType(CreateProjectDto)`
- `ProjectQueryDto`: `search` (string), `centerId`, `status`, `fundingSource`, `programId` (filters mappings), `page` (default 1), `limit` (default 20, max 100)
- `ProjectsService`:
  - `create(dto, userId)` — sets `createdBy`, returns saved entity
  - `findAll(query)` — paginated, applies all filters, returns `{ data: Project[], total, page, limit }`
  - `findOne(id)` — includes center relation, countries, and aggregate mapping status summary
  - `update(id, dto)` — validates existence first, returns updated entity
  - `archive(id)` — sets status to `archived`, does not delete
- All service methods log at `debug` level on success, `error` on failure

**Dependencies**: BE-3.1

---

### BE-3.3 — Projects Controller

**Layer**: Backend
**Complexity**: S

**Description**: Wire the projects service into a REST controller with proper role enforcement and response shaping.

**Acceptance Criteria**:
- `ProjectsController` at `GET|POST|PATCH|DELETE /api/projects`
- `POST /api/projects` and `PATCH /api/projects/:id` and `DELETE /api/projects/:id` — admin only (`@Roles('admin')`)
- `GET /api/projects` and `GET /api/projects/:id` — any authenticated user
- `DELETE /api/projects/:id` calls `archive()` not hard delete — returns 204
- Response serialization excludes internal/audit fields using `ClassSerializerInterceptor` and `@Exclude()` on sensitive columns
- Swagger `@ApiTags('projects')`, `@ApiOperation()`, `@ApiResponse()` decorators on all endpoints
- `@CurrentUser()` decorator extracts user from request (defined in `common/decorators/`)

**Dependencies**: BE-3.2

---

### FE-3.1 — Projects Service & State (Angular)

**Layer**: Frontend
**Complexity**: S

**Description**: Create the Angular-side projects service and signal-based state for the projects feature.

**Acceptance Criteria**:
- `features/projects/services/projects.service.ts` — typed methods: `getProjects(query?)`, `getProject(id)`, `createProject(dto)`, `updateProject(id, dto)`, `archiveProject(id)` — all return Observables
- `ProjectsStore` (or signal-based service) holds: `projects` signal, `selectedProject` signal, `loading` signal, `error` signal, `pagination` signal
- Interfaces/models in `features/projects/models/project.model.ts` match the API response shapes
- `ReferenceDataService` (`core/services/`) fetches and caches centers, programs, countries (used in forms)
- Unit-testable (pure service, no DOM dependencies)

**Dependencies**: FE-1.2

---

### FE-3.2 — Projects List Page

**Layer**: Frontend
**Complexity**: M

**Description**: Build the projects list view with filtering, pagination, and role-aware action buttons.

**Acceptance Criteria**:
- Route: `/projects` lazy-loaded under `LayoutComponent`
- PrimeNG `Table` with columns: Name, Center, Start/End Date, Budget, Funding Source, Status, Actions
- Server-side pagination: page size selector (10/20/50), page navigation
- Filter toolbar: text search (debounced 300ms), Center dropdown, Status dropdown, Funding Source dropdown
- Action column: "View" for all roles; "Edit" and "Archive" buttons shown only for `admin` role
- Status badge uses PrimeNG `Tag` component: `active` = green, `draft` = yellow, `archived` = grey
- Empty state illustration when no projects match filters
- Loading skeleton (PrimeNG Skeleton) shown during data fetch
- Responsive: table scrolls horizontally on mobile

**Dependencies**: FE-3.1

---

### FE-3.3 — Project Create/Edit Form

**Layer**: Frontend
**Complexity**: L

**Description**: Full project form for admin create and edit, with all required fields and validation.

**Acceptance Criteria**:
- Route: `/projects/new` and `/projects/:id/edit` — admin only (RoleGuard)
- PrimeNG form components: `InputText`, `Textarea`, `Calendar` (date range), `InputNumber` (budget fields), `Dropdown` (center, funding source), `MultiSelect` (countries), `InputText` (funder)
- Reactive form with `FormBuilder`, all fields validated (required, date range: start < end, budget > 0)
- Center dropdown populated from `ReferenceDataService.getCenters()`
- Countries multi-select populated from `ReferenceDataService.getCountries()` with search/filter within the dropdown
- Funding source dropdown: Window 3, Bilateral, SRV, Other
- On submit: calls `createProject()` or `updateProject()`, shows PrimeNG `Toast` on success/error
- Cancel button navigates back to list; unsaved changes prompt confirmation dialog (`ConfirmDialog`)
- Edit mode pre-populates all fields from `ProjectsStore.selectedProject`

**Dependencies**: FE-3.1, Wave 2 BE-2.4 (for reference data dropdowns)

---

### FE-3.4 — Project Detail Page

**Layer**: Frontend
**Complexity**: M

**Description**: Read-only project detail view accessible to all roles, showing full project info and a summary of its mapping status.

**Acceptance Criteria**:
- Route: `/projects/:id`
- All project fields displayed in a structured layout using PrimeNG `Card` sections: General Info, Budget, Timeline, Countries, Funding
- Mapping Summary section: PrimeNG `ProgressBar` showing total allocated % across all approved mappings, list of programs mapped with their allocation % and approval status badges
- "Edit Project" button shown only for `admin`
- "Map to My Program" button shown for `program_rep` (navigates to mapping create form — Wave 4)
- Breadcrumb navigation: Dashboard > Projects > [Project Name]
- If project is archived, shows an info banner

**Dependencies**: FE-3.1, FE-3.3

---

## Wave 4 — Program Mapping Workflow

**Goal**: Program Representatives can map projects to their program with allocation %, set ratings, and view all mappings. The system enforces the 100% allocation rule.

**API Contract**:
```
GET    /api/mappings                    (filtered list — role-aware)
GET    /api/mappings/:id
POST   /api/mappings                    (program_rep only)
PATCH  /api/mappings/:id               (program_rep only — own mappings, pending only)
DELETE /api/mappings/:id               (program_rep only — own pending mappings)
GET    /api/projects/:id/allocation    (total allocated % for a project)
```

---

### BE-4.1 — ProjectMapping Entity + Migration

**Layer**: Backend / Database
**Complexity**: S

**Description**: Create the `ProjectMapping` entity which is the core of the workflow.

**Acceptance Criteria**:
- `project_mapping.entity.ts` with all columns per schema: `projectId`, `programId`, `allocationPercentage` (decimal 5,2), `complementarityRating` (enum: `high|medium|low`, nullable), `efficiencyRating` (enum: `high|medium|low`, nullable), `status` (enum: `pending|approved|rejected`, default `pending`), `rejectionReason` (text, nullable), `submittedBy` (FK -> users), `reviewedBy` (FK -> users, nullable), `submittedAt`, `reviewedAt`
- Unique constraint on `(projectId, programId)` — a program can only have one mapping per project
- Migration `CreateProjectMappingsTable` generated and working
- Relations defined to `Project`, `Program`, `User` (submittedBy, reviewedBy)

**Dependencies**: BE-3.1

---

### BE-4.2 — Mappings Service with Allocation Validation

**Layer**: Backend
**Complexity**: L

**Description**: Implement mapping CRUD with the critical 100% allocation business rule enforcement.

**Acceptance Criteria**:
- `CreateMappingDto`: `projectId`, `allocationPercentage` (number, min 1, max 100) — `programId` is taken from the authenticated user, not from the request body
- `UpdateMappingDto`: `allocationPercentage`, `complementarityRating`, `efficiencyRating` (all optional)
- `MappingsService`:
  - `create(dto, user)` — validates: (1) project exists and is active, (2) user is a `program_rep` with a `programId`, (3) no existing mapping for this project+program, (4) new allocation would not push total over 100% (sum existing non-rejected mappings + new amount <= 100). Throws `ConflictException` if duplicate, `BadRequestException` if over 100%
  - `findAll(query, user)` — admin sees all; `program_rep` sees only their program's mappings; `center_rep` sees mappings for projects belonging to their center
  - `findOne(id, user)` — with ownership/access check
  - `update(id, dto, user)` — only `program_rep` who submitted it, only when `status = pending`; re-validates allocation sum
  - `remove(id, user)` — same ownership restrictions as update
  - `getAllocationSummary(projectId)` — returns `{ totalAllocated, remaining, mappings: [{ program, allocation, status }] }` — used by frontend ProgressBar
- Log all allocation validation failures at `warn` level

**Technical Notes**:
- The 100% check must exclude `rejected` mappings from the sum
- Use a DB transaction when creating a mapping to prevent race conditions on allocation sum (SELECT FOR UPDATE on existing mappings)

**Dependencies**: BE-4.1, BE-3.2

---

### BE-4.3 — Mappings Controller

**Layer**: Backend
**Complexity**: S

**Description**: Wire mappings service into REST controller.

**Acceptance Criteria**:
- All endpoints per the Wave 4 API contract above
- `POST /api/mappings` — `program_rep` only
- `PATCH /api/mappings/:id` and `DELETE /api/mappings/:id` — `program_rep` only, with ownership check inside service
- `GET /api/projects/:id/allocation` — any authenticated user, returns allocation summary
- Swagger decorators on all endpoints
- 404 returned with descriptive message when mapping not found
- 409 returned for duplicate mapping
- 400 returned with message "Allocation would exceed 100% for this project" when over-allocation attempted

**Dependencies**: BE-4.2

---

### FE-4.1 — Mappings Service & State (Angular)

**Layer**: Frontend
**Complexity**: S

**Description**: Angular-side mappings service and signal-based state.

**Acceptance Criteria**:
- `features/mappings/services/mappings.service.ts` — typed methods matching the API contract
- `MappingsStore` signals: `mappings`, `selectedMapping`, `loading`, `error`
- `getAllocationSummary(projectId)` method for the allocation progress display
- Models in `features/mappings/models/mapping.model.ts`

**Dependencies**: FE-1.2

---

### FE-4.2 — Mappings List Page

**Layer**: Frontend
**Complexity**: M

**Description**: Role-aware list of program mappings with filtering.

**Acceptance Criteria**:
- Route: `/mappings` lazy-loaded
- PrimeNG `Table` with columns: Project Name, Program, Allocation %, Ratings, Status, Submitted Date, Actions
- Filters: status (All/Pending/Approved/Rejected), program (admin only), search by project name
- Status badge: `pending` = blue, `approved` = green, `rejected` = red
- `program_rep` sees only their own mappings; row-level Edit and Delete actions for pending mappings only
- `center_rep` sees mappings for their center's projects; "Review" action button (navigates to approval detail — Wave 5)
- Admin sees all mappings
- Allocation % shown as a fraction "50% of 100%" with color coding (red if total > 100%)

**Dependencies**: FE-4.1

---

### FE-4.3 — Create/Edit Mapping Form

**Layer**: Frontend
**Complexity**: M

**Description**: Form for Program Representatives to map a project to their program.

**Acceptance Criteria**:
- Route: `/mappings/new?projectId=X` and `/mappings/:id/edit`
- `program_rep` role required (RoleGuard)
- Project selector: PrimeNG `AutoComplete` with search — pre-filled if `projectId` query param is present
- Allocation % field: `InputNumber`, min 1, max 100, shows "Remaining available: X%" below the field (fetched from `getAllocationSummary`)
- Complementarity Rating: PrimeNG `SelectButton` with High/Medium/Low options (optional field)
- Efficiency Rating: same pattern
- Real-time allocation feedback: as user types the %, shows updated remaining capacity
- Validation prevents submit if allocation would exceed remaining
- On success: navigates to mappings list with success toast

**Dependencies**: FE-4.1, BE-4.3

---

## Wave 5 — Center Approval Workflow

**Goal**: Center Representatives can review, approve, or reject program mappings for projects in their center.

**API Contract**:
```
POST /api/mappings/:id/approve
POST /api/mappings/:id/reject    { reason: string }
GET  /api/projects/:id/review-summary
```

---

### BE-5.1 — Approval/Rejection Service Methods

**Layer**: Backend
**Complexity**: M

**Description**: Add the approval workflow methods to `MappingsService`.

**Acceptance Criteria**:
- `approve(id, centerRepUser)` — validates: (1) mapping exists, (2) mapping status is `pending`, (3) center rep's center matches the project's center, (4) sets `status = approved`, `reviewedBy = user.id`, `reviewedAt = now()`
- `reject(id, reason, centerRepUser)` — same validations + requires non-empty `reason` string, sets `status = rejected`, `rejectionReason = reason`
- `getReviewSummary(projectId, user)` — returns all mappings for the project with their status, allocation %, ratings, rejection reasons; access restricted to the project's center rep and admins
- All state transitions logged at `info` level with project ID, mapping ID, user ID, and new status
- `ForbiddenException` thrown when center rep tries to review a project from another center

**Dependencies**: BE-4.2

---

### BE-5.2 — Approval Controller Endpoints

**Layer**: Backend
**Complexity**: S

**Description**: Wire approval endpoints into the mappings controller.

**Acceptance Criteria**:
- `POST /api/mappings/:id/approve` — `center_rep` only
- `POST /api/mappings/:id/reject` — `center_rep` only, body: `{ reason: string }` (validated, non-empty)
- `GET /api/projects/:id/review-summary` — admin or center_rep only
- 400 returned if trying to approve/reject a non-pending mapping (with message: "Mapping is already reviewed")
- 403 returned if center rep tries to act on a project not in their center

**Dependencies**: BE-5.1

---

### FE-5.1 — Mapping Review Detail Page

**Layer**: Frontend
**Complexity**: M

**Description**: Full review interface for Center Representatives to approve or reject a mapping.

**Acceptance Criteria**:
- Route: `/mappings/:id/review` — `center_rep` and `admin` only
- Displays full project info panel (read-only): name, center, budget, timeline
- Displays the program's mapping details: program name, allocation %, complementarity rating, efficiency rating
- Shows overall allocation summary for the project (ProgressBar + breakdown table)
- Two action buttons: "Approve" (success style) and "Reject" (danger style)
- "Reject" opens a PrimeNG `Dialog` with a required `Textarea` for the rejection reason (min 10 chars)
- "Approve" shows a `ConfirmDialog` before calling the API
- On success: navigates back to mappings list with appropriate toast
- If mapping is already reviewed (approved/rejected), shows read-only status and reason; action buttons hidden

**Dependencies**: FE-4.1, BE-5.2

---

### FE-5.2 — Project Review Summary Panel

**Layer**: Frontend
**Complexity**: S

**Description**: Summary panel showing all program mappings for a project, accessible from the project detail page.

**Acceptance Criteria**:
- Integrated into the Project Detail page (FE-3.4) as an additional tab or expandable panel
- Shows each mapping row: Program Name, Allocation %, Status badge, Ratings, Center Rep review date
- Total allocation progress bar (ProgressBar) with `X% allocated`
- "Review" action links shown for `center_rep` on pending items
- For rejected items: shows rejection reason in an expandable inline panel

**Dependencies**: FE-3.4, BE-5.2

---

## Wave 6 — CSV Data Import

**Goal**: One-time admin-triggered import of the TOC_Projects.csv data into the database, with normalization and conflict handling.

**Note**: This is backend-only. The frontend gets a simple trigger button on the admin panel.

---

### BE-6.1 — CSV Import Service

**Layer**: Backend
**Complexity**: L

**Description**: Implement a robust CSV import service that parses the TOC_Projects.csv, normalizes data, resolves relationships, and upserts into the database.

**Acceptance Criteria**:
- `ImportService` in `modules/import/`
- Reads CSV from a configurable file path (env var `IMPORT_CSV_PATH`, defaults to `./data/TOC_Projects.csv`)
- Normalization rules (hardcoded mapping):
  - Funding source: `W3`, `Window 3`, `Windows 3`, `WINDOW 3 - RESTRICTED`, `Window 3 - Restricted` -> `window3`; `Bilateral`, `BILATERAL - RESTRICTED`, `BILATERAL- RESTRICTED`, `Bilateral - Restricted`, `bilateral` -> `bilateral`; `SRV` -> `srv`; anything else -> `other`
  - Budget allocation: multiply decimal (0.5) by 100 to get percentage (50)
  - Dates: parse `DD-MMM-YY` format (e.g., `21-Nov-24`) to ISO date
  - Director review: `Agree` -> status `approved`, `Disagree` -> status `rejected`, blank -> `pending`
  - Ratings: `High` -> `high`, `Med` / `Medium` -> `medium`, `Low` -> `low`, blank -> null
- For each CSV row:
  1. Find or create the Project by name (upsert)
  2. Resolve Center by matching name to local `centers` table (fuzzy-ok: trim + case-insensitive)
  3. Resolve Program by matching name to local `programs` table
  4. Resolve Countries from the `Countries` column (comma-separated, match to `countries` table)
  5. Create the `ProjectMapping` with allocation, ratings, status, reason if rejected
- Import summary returned: `{ created, updated, skipped, errors: [{ row, reason }] }`
- All unresolvable centers/programs logged as warnings (not errors) — import continues
- Wrapped in a DB transaction per project row — if a row fails, it's skipped and logged

**Technical Notes**:
- Use `csv-parse` npm package (lightweight, well-maintained) for CSV parsing
- Country field in CSV has values like `country`, `global`, or comma-separated country names — handle the `country` and `global` special values gracefully (map to empty set or a "global" flag)
- The same project name may appear multiple times (once per program mapping) — do not create duplicate projects

**Dependencies**: BE-3.2, BE-4.2

---

### BE-6.2 — Import Controller + Frontend Trigger

**Layer**: Backend + Frontend
**Complexity**: S

**Description**: Admin endpoint to trigger the CSV import and a simple UI button.

**Acceptance Criteria**:
- `POST /api/admin/import-csv` — admin only, triggers `ImportService`, returns import summary
- Endpoint is idempotent (safe to run multiple times — will update existing records, not duplicate)
- Response: `{ created, updated, skipped, errors }` with HTTP 200
- Frontend: Admin section (or settings page) has an "Import CSV Data" button that calls this endpoint and displays the result summary in a PrimeNG `Dialog`

**Dependencies**: BE-6.1, FE-1.1 (for the admin UI hook-in)

---

## Wave 7 — Dashboard & Reporting

**Goal**: Role-aware dashboard with key metrics, charts, and filtered views. All roles see relevant data on login.

**API Contract**:
```
GET /api/dashboard/summary          (role-aware aggregate stats)
GET /api/dashboard/allocation-status (per-project allocation completion)
GET /api/dashboard/recent-activity  (latest mappings/approvals)
```

---

### BE-7.1 — Dashboard Aggregation Endpoints

**Layer**: Backend
**Complexity**: M

**Description**: Efficient aggregate queries powering the dashboard.

**Acceptance Criteria**:
- `GET /api/dashboard/summary` — returns (role-filtered):
  - Admin: `{ totalProjects, activeProjects, totalMappings, pendingApprovals, fullyAllocatedProjects, centers: N, programs: N }`
  - Program Rep: `{ myMappings, pendingMappings, approvedMappings, rejectedMappings, totalAllocated: % }`
  - Center Rep: `{ projectsInCenter, pendingReviews, approvedMappings, rejectedMappings }`
- `GET /api/dashboard/allocation-status` — array of projects with `{ id, name, allocatedPercent, status, mappingCount }` sorted by least allocated first; admin sees all, center rep sees their center only
- `GET /api/dashboard/recent-activity` — last 10 mapping events (creation, approvals, rejections) with actor, action, timestamp; role-filtered
- All queries use TypeORM `QueryBuilder` with aggregates, no N+1 queries
- Results cached for 2 minutes (same Map-based cache pattern from BE-2.4)

**Dependencies**: BE-4.2, BE-5.1

---

### FE-7.1 — Dashboard Page

**Layer**: Frontend
**Complexity**: L

**Description**: Role-aware dashboard with stat cards, a chart, and recent activity feed.

**Acceptance Criteria**:
- Route: `/dashboard` (default landing page after login)
- **Admin view**: 6 stat cards (total projects, active, pending approvals, fully allocated, centers, programs). Bar chart (PrimeNG Chart.js wrapper) showing projects per funding source. Allocation status table (least allocated projects at top, with ProgressBar per row)
- **Program Rep view**: 4 stat cards (my mappings, pending, approved, rejected). Donut chart showing allocation breakdown. Recent activity list
- **Center Rep view**: 4 stat cards (projects in center, pending reviews, approved, rejected). List of projects needing review (direct links to `/mappings/:id/review`)
- Loading skeleton for all cards during data fetch
- Refresh button (top right) re-fetches all dashboard data
- Responsive grid layout using PrimeFlex

**Dependencies**: FE-1.2, BE-7.1

---

### FE-7.2 — Users Management Page (Admin)

**Layer**: Frontend
**Complexity**: M

**Description**: Admin page to view and manage system users (link user accounts to programs/centers, activate/deactivate).

**Acceptance Criteria**:
- Route: `/admin/users` — admin only
- PrimeNG `Table` listing users: Name, Email, Role badge, Linked Program/Center, Status (Active/Inactive)
- Inline edit for `programId` / `centerId` assignment (Dropdown populated from reference data)
- Toggle Active/Inactive status per user
- No create/delete user — user creation happens via Cognito; this page manages role assignments
- `PATCH /api/users/:id` backend endpoint (admin only): accepts `{ programId?, centerId?, isActive? }` and updates user

**Technical Notes**:
- This requires adding a `PATCH /api/users/:id` endpoint to `UsersModule` — add a `BE-7.2` sub-task if this is easier to track separately
- Role cannot be changed from this UI (role is sourced from Cognito claims)

**Dependencies**: FE-1.2, BE-1.2

---

## Wave 8 — QA Hardening & Polish

**Goal**: Close all gaps identified by QA agents, add missing tests, harden security, and ensure production readiness.

---

### BE-8.1 — Security Hardening

**Layer**: Backend
**Complexity**: M

**Description**: Apply security best practices across the API.

**Acceptance Criteria**:
- `helmet` middleware applied in `main.ts`
- Rate limiting on auth endpoints (`/api/auth/*`): 10 req/min per IP using `@nestjs/throttler`
- Input sanitization: all string inputs trimmed at DTO transform level
- JWT expiry validation strictly enforced (no leeway)
- Sensitive fields (`password`, `cognitoSub` in logs) redacted from log output
- `PATCH /api/users/:id` validates that a `program_rep` cannot be assigned a `centerId` and vice versa

**Dependencies**: All previous BE waves

---

### BE-8.2 — API Integration Tests

**Layer**: Backend
**Complexity**: M

**Description**: E2E tests covering the core workflow using NestJS testing utilities.

**Acceptance Criteria**:
- Test suite in `test/` covering:
  - Auth: callback code exchange, JWT validation, role enforcement (401/403 cases)
  - Projects: CRUD by admin, read-only access by other roles
  - Mappings: create with allocation validation, over-100% rejection, duplicate rejection
  - Approval: approve/reject by correct center rep, cross-center rejection (403)
- Uses an in-memory SQLite DB or a test MySQL DB (docker-compose test profile)
- All tests pass cleanly with `npm run test:e2e`

**Dependencies**: All previous BE waves

---

### FE-8.1 — UI Polish & Accessibility

**Layer**: Frontend
**Complexity**: M

**Description**: Final UI pass ensuring visual consistency, loading states, error handling, and basic accessibility.

**Acceptance Criteria**:
- All pages have consistent page titles (set via Angular `Title` service)
- All API errors (400, 403, 404, 500) surface via PrimeNG `Toast` with appropriate messages
- Global error handler in Angular (`ErrorHandler`) catches uncaught errors and shows a generic toast
- All buttons have `aria-label` attributes; all form fields have associated `<label>` elements
- Keyboard navigable primary actions (tab + enter)
- All tables have loading skeletons (not spinners) during fetch
- Empty states for all list views
- 404 page route for unknown paths
- Consistent spacing using PrimeFlex utilities across all pages

**Dependencies**: All previous FE waves

---

### INFRA-8.1 — Production Docker Compose Review

**Layer**: Infrastructure
**Complexity**: S

**Description**: Review and finalize the production Docker Compose configuration.

**Acceptance Criteria**:
- `docker-compose.prod.yml` has separate API and Web services with correct build contexts
- Nginx config reverse-proxies `/api/*` to the NestJS container and `/*` to the Angular build output
- Health check configured for the API container
- MySQL volume named and persistent
- No development tools (phpMyAdmin) in prod compose
- `LOG_FORMAT=json` set in prod API environment
- `.env.example` updated with all variables added during development (CLARISA, Cognito, import path)

**Dependencies**: All waves

---

## Execution Sequence & Parallelism Map

```
Week 1
  Day 1-2: BE-1.1, BE-1.2 (sequential) | FE-1.1 (parallel)
  Day 2-4: BE-1.3 (Cognito)             | FE-1.2 (parallel, mock BE)

Week 2
  Day 1-2: BE-2.1, BE-2.2, BE-2.3, BE-2.4 (sequential, BE only)
           FE can start FE-3.1, FE-3.2 using mock/hardcoded reference data
  Day 3-5: BE-3.1, BE-3.2, BE-3.3       | FE-3.3, FE-3.4

Week 3
  Day 1-3: BE-4.1, BE-4.2, BE-4.3       | FE-4.1, FE-4.2, FE-4.3
  Day 3-5: BE-5.1, BE-5.2               | FE-5.1, FE-5.2

Week 4
  Day 1-2: BE-6.1, BE-6.2 (CSV import)
  Day 2-4: BE-7.1                        | FE-7.1, FE-7.2
  Day 4-5: QA Gate -> ui-tester + qa-test-engineer

Week 5
  Day 1-3: BE-8.1, BE-8.2, FE-8.1, INFRA-8.1 (fix cycle from QA)
  Day 4-5: Final QA Gate + sign-off
```

---

## Task Summary Table

| ID | Title | Agent | Complexity | Wave | Depends On |
|----|-------|-------|------------|------|------------|
| BE-1.1 | Bootstrap API Infrastructure | nestjs-backend-expert | M | 1 | — |
| BE-1.2 | Base Entity + User Entity + Migration | nestjs-backend-expert | S | 1 | BE-1.1 |
| BE-1.3 | Cognito Auth Module | nestjs-backend-expert | L | 1 | BE-1.1, BE-1.2 |
| FE-1.1 | Angular Shell: Layout, Routing, Theme | angular-frontend-expert | M | 1 | — |
| FE-1.2 | Cognito OAuth2 Flow in Angular | angular-frontend-expert | M | 1 | FE-1.1 |
| BE-2.1 | CLARISA HTTP Client Module | nestjs-backend-expert | S | 2 | BE-1.1 |
| BE-2.2 | Reference Data Entities + Migrations | nestjs-backend-expert | M | 2 | BE-1.2, BE-2.1 |
| BE-2.3 | CLARISA Sync Service + Admin Endpoint | nestjs-backend-expert | M | 2 | BE-2.2 |
| BE-2.4 | Reference Data REST Endpoints | nestjs-backend-expert | S | 2 | BE-2.3 |
| BE-3.1 | Project Entity + Migration | nestjs-backend-expert | M | 3 | BE-2.2 |
| BE-3.2 | Projects Service & DTOs | nestjs-backend-expert | M | 3 | BE-3.1 |
| BE-3.3 | Projects Controller | nestjs-backend-expert | S | 3 | BE-3.2 |
| FE-3.1 | Projects Service & State | angular-frontend-expert | S | 3 | FE-1.2 |
| FE-3.2 | Projects List Page | angular-frontend-expert | M | 3 | FE-3.1 |
| FE-3.3 | Project Create/Edit Form | angular-frontend-expert | L | 3 | FE-3.1 |
| FE-3.4 | Project Detail Page | angular-frontend-expert | M | 3 | FE-3.1, FE-3.3 |
| BE-4.1 | ProjectMapping Entity + Migration | nestjs-backend-expert | S | 4 | BE-3.1 |
| BE-4.2 | Mappings Service with Allocation Validation | nestjs-backend-expert | L | 4 | BE-4.1, BE-3.2 |
| BE-4.3 | Mappings Controller | nestjs-backend-expert | S | 4 | BE-4.2 |
| FE-4.1 | Mappings Service & State | angular-frontend-expert | S | 4 | FE-1.2 |
| FE-4.2 | Mappings List Page | angular-frontend-expert | M | 4 | FE-4.1 |
| FE-4.3 | Create/Edit Mapping Form | angular-frontend-expert | M | 4 | FE-4.1 |
| BE-5.1 | Approval/Rejection Service Methods | nestjs-backend-expert | M | 5 | BE-4.2 |
| BE-5.2 | Approval Controller Endpoints | nestjs-backend-expert | S | 5 | BE-5.1 |
| FE-5.1 | Mapping Review Detail Page | angular-frontend-expert | M | 5 | FE-4.1, BE-5.2 |
| FE-5.2 | Project Review Summary Panel | angular-frontend-expert | S | 5 | FE-3.4, BE-5.2 |
| BE-6.1 | CSV Import Service | nestjs-backend-expert | L | 6 | BE-3.2, BE-4.2 |
| BE-6.2 | Import Controller + Frontend Trigger | nestjs-backend-expert + angular-frontend-expert | S | 6 | BE-6.1 |
| BE-7.1 | Dashboard Aggregation Endpoints | nestjs-backend-expert | M | 7 | BE-4.2, BE-5.1 |
| FE-7.1 | Dashboard Page | angular-frontend-expert | L | 7 | FE-1.2, BE-7.1 |
| FE-7.2 | Users Management Page | angular-frontend-expert | M | 7 | FE-1.2, BE-1.2 |
| BE-8.1 | Security Hardening | nestjs-backend-expert | M | 8 | All BE |
| BE-8.2 | API Integration Tests | nestjs-backend-expert | M | 8 | All BE |
| FE-8.1 | UI Polish & Accessibility | angular-frontend-expert | M | 8 | All FE |
| INFRA-8.1 | Production Docker Compose Review | devops-docker-jenkins | S | 8 | All waves |

**Total tasks: 36 | Complexity breakdown: XS: 0, S: 12, M: 17, L: 6, XL: 0**

---

## QA Gates

**After Wave 3**: `ui-tester` validates project list + detail pages. `qa-test-engineer` validates `GET/POST/PATCH /api/projects`.

**After Wave 5**: `ui-tester` validates end-to-end mapping + approval flow. `qa-test-engineer` validates allocation enforcement (over 100% rejection, duplicate rejection, cross-center 403).

**After Wave 7**: Full system QA — both agents test all flows together including dashboard accuracy.

**After Wave 8**: Final sign-off QA — regression on all previously passing tests + new security/accessibility checks.

---

## Open Questions Requiring Client Validation

Before Wave 4 development starts, confirm these with the client:

1. **Cognito custom attributes**: Does the Cognito user pool have `custom:role`, `custom:programId`, and `custom:centerId` attributes configured? If not, the role-linking strategy for BE-1.2/BE-1.3 needs to change (likely: admin assigns roles via the Users Management page, and roles live entirely in our DB, not in Cognito claims).

2. **Allocation timing**: Can a project be "live" with less than 100% allocated (e.g., 80% allocated, two programs mapped)? Or must all mapping submissions be complete before center reps review?

3. **Multiple center reps per center**: The current design assumes one center rep per center. Is this correct, or should multiple users share the center rep role for the same center?

4. **Rejection and resubmission**: When a center rep rejects a mapping, can the program rep edit and resubmit? The current schema allows it (edit pending mappings), but the status flow for "rejected then resubmitted" needs to be explicit (does it go back to `pending`? does the rejection reason persist?).

5. **Project code format**: The CSV has codes like `S0003`, `N-344002`, `T-PJ-004023`, `D-200394`, `P-1520`. Should these be a separate `code` field on the project, or is the `name` field the full string including the code prefix?