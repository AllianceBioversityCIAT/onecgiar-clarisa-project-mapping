# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PRMS Projects Registry is a project management and registry tool for CGIAR's Performance and Results Management System (PRMS). It enables tracking, managing, and reporting on research projects across the CGIAR portfolio.

**Core workflow**: Admin creates projects → Center Rep initiates mappings to programs with % allocation → Center and Program Reps negotiate via a chat/counter-propose thread → when all mappings are agreed and total = 100%, the Center Rep locks the project round (project-level `negotiation_locked` flag is the single source of truth).

## Repository Structure

```
PRMS-Projects-Registry/
├── api/                 # NestJS backend (latest, TypeScript, TypeORM, MySQL 8)
│   ├── src/
│   │   ├── common/      # Guards, decorators, interceptors, filters, base entity, DTOs, logger
│   │   ├── config/      # Typed config (app, database, auth, clarisa)
│   │   ├── database/    # data-source.ts, migrations/
│   │   └── modules/     # Feature modules (auth, users, projects, mappings, reference-data, clarisa, import, dashboard)
│   ├── test/
│   ├── .env.example
│   └── package.json
├── web/                 # Angular 21 app (PrimeNG v21, SCSS)
│   ├── src/
│   │   ├── app/
│   │   │   ├── core/        # Services (auth, api, reference-data), interceptors (auth, error), guards, error handler
│   │   │   ├── features/    # Lazy-loaded: dashboard, projects, mappings, users, auth, not-found
│   │   │   ├── shared/      # Shared components, pipes, directives
│   │   │   └── layout/      # LayoutComponent (sidebar + toolbar shell)
│   │   ├── assets/
│   │   ├── styles/
│   │   └── environments/
│   └── package.json
├── docker-compose.yml       # Dev environment (api, web, mysql, phpmyadmin)
├── docker-compose.prod.yml  # Production environment (api, web, mysql, nginx)
├── nginx/               # Nginx config, reverse proxy
├── logs/                # Winston log files (gitignored except .gitkeep)
├── media/               # Uploaded files (gitignored except .gitkeep)
├── .claude/             # Agent definitions, agent memory, implementation plan
└── CLAUDE.md
```

## Build & Run Commands

### Back-end (`api/`)
```bash
npm run start:dev          # Development with watch mode (port 3000)
npm run build              # Production build
npm run start:prod         # Run production build
npm run migration:generate -- src/database/migrations/MigrationName
npm run migration:run      # Run pending migrations
npm run migration:revert   # Revert last migration
npm test                   # Jest unit tests
npm run test:e2e           # End-to-end tests
```

### Front-end (`web/`)
```bash
npm start                  # Dev server (https://localhost:4200, SSL enabled)
npm run build              # Production build
```

### Docker (from repo root)
```bash
docker-compose up --build  # Build and start all services
docker-compose down        # Stop (keep data)
docker-compose down -v     # Stop and wipe MySQL volume
```
Services: API (3000), Web (4200), MySQL (3306), phpMyAdmin (8080)

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Backend framework | NestJS | Latest (v10+) |
| Frontend framework | Angular | 21 |
| UI library | PrimeNG | 21 |
| Database | MySQL | 8.0 |
| ORM | TypeORM | Latest (migrations only, `synchronize: false` always) |
| Styling | SCSS + PrimeNG theme | — |
| State management | Angular Signals + Services | — |
| Auth | AWS Cognito OAuth2 + local JWT (access 15min + httpOnly refresh cookie 30d) | — |
| External API | CLARISA (Centers, Programs, Countries, Action Areas) | — |
| Logging | Winston + winston-daily-rotate-file | — |
| Container | Docker + Docker Compose | — |
| Node.js | 22 LTS | — |

### Key Technical Notes
- **Node.js 22 required** — use `nvm use 22` (`.nvmrc` in root)
- **Angular 21 polyfills**: Must add `"polyfills": ["zone.js"]` to `angular.json` build options
- **Angular 21 serve**: `"ssl": true` and `"allowedHosts": ["localhost"]` in angular.json serve options
- **PrimeNG v21 naming changes**: `Select` (not Dropdown), `DatePicker` (not Calendar), `Textarea` from `primeng/textarea` (not `InputTextareaModule`), `p-select`/`p-datepicker` in templates, `optionLabel` (not `[field]`) on AutoComplete
- **PrimeNG overlays — `appendTo="body"` is needed in three places**: (1) `app.config.ts` sets `providePrimeNG({ overlayOptions: { appendTo: 'body' } })` which covers `p-select`, `p-multiselect`, `p-autocomplete`, `p-cascadeselect`, `p-treeselect`, `p-colorpicker`, `p-password` (every component that consumes `OverlayOptions` from the global config). (2) **`p-datepicker` does NOT consume the global `OverlayOptions`** — it has its own `appendTo` `InputSignal` and must get `appendTo="body"` on every instance, or its calendar panel gets clipped by parent `overflow: hidden` / stacking contexts. (3) **`p-table`'s paginator dropdown is also separate** — pass `paginatorDropdownAppendTo="body"` on every paginated `<p-table>` to keep the "rows per page" dropdown from being clipped.
- All monetary values: `decimal(10,2)` in DB, never `float`
- PrimeNG theme: Aura preset with custom PRMS design tokens (primary: `#5569dd`)
- TypeORM QueryBuilder with `getManyAndCount()` + `leftJoinAndSelect`: use **raw DB column names** in `orderBy` (`project.created_at`) and use `offset/limit` instead of `skip/take` to avoid the `databaseName` undefined bug
- TypeORM QueryBuilder `.where()` / `.andWhere()`: use **camelCase** property names (`project.centerId`), NOT snake_case (`project.center_id`)
- Angular assets: files go in `web/public/` (served at root) or `web/src/assets/` (served at `/assets/`). Both are configured in `angular.json`
- CORS: supports comma-separated origins in `CORS_ORIGIN` env var (e.g. `https://localhost:4200,http://localhost:4202`)

### Authentication Flow
- **Cognito** handles login only (OAuth2 authorization code flow)
- **Roles managed internally** — admin assigns roles via Users page, NOT from Cognito claims
- Backend exchanges Cognito code for tokens, verifies ID token via JWKS (issuer extracted dynamically from token's `iss` claim), upserts user, issues local JWT
- Access token stored in Angular signal (memory only, never localStorage)
- Refresh token in httpOnly cookie (path: `/`, 30-day expiry)
- On page refresh: Angular calls `POST /auth/refresh` → gets new access token → calls `GET /auth/me`
- **No API global prefix** — NestJS routes are mounted at root (`/auth/...`, `/projects/...`, `/mappings/...`). `main.ts` does NOT call `setGlobalPrefix`. The web container's nginx proxies `/api/*` → api service with the `/api` prefix stripped.
- `AuthService.initialized` promise must be awaited by guards before checking auth state
- **JWT carries `centerIds: number[]`** — full ordered list of centers a `center_rep` belongs to (sorted by `user_centers.sort_order` ASC; primary first). Empty `[]` for non-center-rep roles. `users.center_id` is retained as the *primary/default* center (= `centerIds[0]`). `GET /auth/me` also returns the resolved `centers: Center[]` array.
- **Active-center overlay** — multi-center reps select an active center via the header `CenterSwitcherComponent`. The Angular auth interceptor attaches `X-Active-Center: <id>` to every API request (except `/auth/*` endpoints) when `centerIds.length > 1`. A global backend `ActiveCenterInterceptor` (`api/src/common/interceptors/active-center.interceptor.ts`) validates the header against `req.user.centerIds` and overlays `req.user.centerId`. All downstream `user.centerId === project.centerId` scoping checks read the overlaid value with no code changes. Forged ids return **403 `{ code: 'ACTIVE_CENTER_INVALID' }`** — `AllExceptionsFilter` preserves the `code` field. Empty `centerIds` + header present → silent pass-through (non-center-rep tooling tolerance).
- **Frontend graceful recovery** — when the backend returns `ACTIVE_CENTER_INVALID` (admin revoked a center mid-session), the Angular error interceptor refreshes `/auth/me`, calls `AuthService.resetActiveCenterToFirst()`, shows a toast, and retries the original request once. Loop guard via `HttpContextToken` prevents infinite retry. `activeCenterId` persisted to `localStorage.prms.activeCenterId`; initialized to `centerIds[0]` on first login; validated on every user refresh.
- **Known limitation**: ≤15min staleness window. After an admin reassigns a rep's centers, the rep's JWT still carries the old `centerIds` until the next access-token refresh. A stale `X-Active-Center` triggers the recovery flow above.

### Dev Login (Browser Testing with Playwright)
To test the app via Playwright MCP (bypasses Cognito, dev-only):

1. **Start test server** (HTTP, no SSL issues): `npx ng serve --configuration test` (port 4202)
2. **Navigate to**: `http://localhost:4202/auth?dev=admin@codeobia.com`
3. This calls `GET /auth/dev-token?email=...` (proxied from `/api/auth/dev-token` by the web container) which returns a JWT + sets a refresh cookie
4. The app redirects to `/dashboard` authenticated as that user
5. **CORS**: Make sure `CORS_ORIGIN` in `.env` includes `http://localhost:4202`
6. **In-app navigation works** — click nav links (don't do full page `goto` to other routes, as the token is in-memory and will be lost)
7. For full-page navigation, re-auth first: `page.goto('http://localhost:4202/auth?dev=admin@codeobia.com')`

**Endpoints (dev-only, NODE_ENV=development):**
- `POST /auth/dev-login` — body `{ email }`, returns `{ accessToken, user }` + sets refresh cookie
- `GET /auth/dev-token?email=...` — same but GET (used by Angular `devLogin()`)

**Playwright output location (MANDATORY):**
All Playwright artifacts — screenshots, page snapshots, traces, and any ad-hoc test output — **must** be written to the `playwright/` directory at the repo root. This keeps the root clean and ensures everything is gitignored automatically.
- Screenshots: `playwright/<descriptive-name>.png`
- Page snapshots: `playwright/<descriptive-name>-snapshot.md`
- When calling `mcp__plugin_playwright_playwright__browser_take_screenshot`, always pass a `filename` parameter under `playwright/` (e.g. `playwright/dashboard-admin.png`) — the tool defaults to the repo root otherwise.
- The Playwright MCP's own console logs land in `.playwright-mcp/` at the CWD; this path is gitignored but should not be used for intentional test artifacts.
- This rule applies to Claude and to every subagent (`ui-tester`, `qa-test-engineer`, etc.) that captures browser output.

### CLARISA Integration
- **Read-only cache** — syncs Centers (16), Programs (14 — Science programs + Accelerators + Scaling programs), Countries (248), Action Areas (3) from `https://api.clarisa.cgiar.org`
- **Programs endpoint**: `/api/cgiar-entities?version=2` filtered by entity_type: "Science programs", "Accelerators", "Scaling programs" (NOT `/api/initiatives`)
- Basic auth credentials in `.env`
- Auto-syncs on first startup if tables are empty
- Admin can trigger manual sync via `POST /admin/sync-clarisa`
- 5-minute in-memory cache on reference data endpoints

## Roles & Permissions

| Role | Can Do |
|------|--------|
| **Admin** | CRUD projects, manage users (assign roles), trigger CSV import, trigger CLARISA sync, view all data. Can exclude/unexclude any project. **Read-only on the negotiation surface** — can view but cannot mutate (no counter-propose, agree, remove, edit allocation, add program, lock, reopen, chat). `workflow_admin` is the cross-center arbiter, not admin. **Cannot edit Anaplan-sourced fields** — `code`, `centerId`, `startDate`, `endDate`, `fundingSource`, `funder`, and the 2026 Anaplan metadata block are immutable for every role (only the CSV import overwrites them). |
| **Program Rep** | Participate in negotiation on mappings to their program: agree, counter-propose allocation, post chat messages, **request removal** (asks the center side; cannot remove unilaterally). Cannot create mappings or lock rounds. **Does not set complementarity / efficiency ratings** — those are a center-side responsibility. |
| **Center Rep** | Initiate mappings for projects in their center; open/counter-propose/agree/remove during negotiation; accept/decline program rep's removal request; post chat messages; **lock** and **reopen** the round (only when all mappings agreed and total = 100%). **Sets complementarity and efficiency ratings** on create and on every center-side allocation edit. Can edit non-Anaplan project metadata on projects in their own center via `PATCH /projects/:id/metadata` (whitelist + justification — see Projects endpoints). Can **exclude/unexclude projects in their own center** — excluded projects are hidden from their default list, dashboard, and mappings list until restored or `showExcluded=true` is passed. **Can belong to multiple centers** — admin assigns 1..N centers via the Users page multiselect; the rep switches between them via the header `CenterSwitcherComponent`. The active center scopes every request (see Authentication Flow → "Active-center overlay"). `centerIds[0]` is the primary (default when no switcher selection). |
| **Workflow Admin** | System-office arbiter: full negotiation rights on every project (counter-propose, agree, remove, accept/decline removal request, add-program, lock, reopen, chat) regardless of center. Lands on `/needs-assistance` queue (mappings auto-flagged after a program rep's 2nd counter-proposal). Cannot manage projects, users, or run admin-only data ops (CSV import, CLARISA sync). |
| **Unit Admin** (PPU/PCU) | Edit whitelisted project metadata on **any** project regardless of `negotiation_locked` state (see `PATCH /projects/:id/metadata`). Trigger published-snapshot republishes. View project audit history. Cannot manage users, mappings, or negotiation. |
| **No role** (null) | Read-only viewer. Can browse `GET /projects` and `GET /projects/:id` only; all mutating endpoints return **403** via `RolesGuard`. Frontend lands on `/projects` (dashboard guard redirects). Nav shows Home / Projects only; planning UI tiles ("Suggested to reach 90%", "What-if Selection", row checkboxes, "Use suggested set") are hidden — admin / center_rep only. |

- Roles stored in `users.role` column (nullable — new users have no role until admin assigns one; they get the **No role** view above until an admin assigns one via Users page)
- `@Roles(UserRole.ADMIN)` decorator + global `RolesGuard` (APP_GUARD)
- `@Public()` decorator bypasses JWT auth (used on auth endpoints, health check)

## Agent Workflow

This project uses specialized agents. **All user instructions must flow through the Project Manager agent first.**

### How It Works

1. **User gives an instruction** (any feature request, task, question, or requirement)
2. **Route to `tech-project-manager` agent first** — it analyzes the instruction, clarifies ambiguities, breaks it into actionable tasks, and reformulates each task with the right technical context for the target agent
3. **Project Manager dispatches to specialist agents** based on expertise:

| Agent | Expertise | Receives tasks about |
|-------|-----------|---------------------|
| `tech-project-manager` | Requirements analysis, task breakdown, architecture planning, scope management | Project planning, specs, ambiguous requirements, multi-agent coordination |
| `angular-frontend-expert` | Angular 21, PrimeNG, state management, forms, data tables | Frontend components, pages, UI/UX, Angular routing, forms, styling |
| `nestjs-backend-expert` | NestJS, MySQL, TypeORM, REST APIs, auth | API endpoints, database schema, services, integrations, backend logic |
| `devops-docker-jenkins` | Docker, Jenkins, CI/CD, deployment, infrastructure | Dockerfiles, pipelines, docker-compose, deployment configs |
| `ui-tester` | UI testing, visual validation, user flow testing | Post-implementation UI verification, interaction testing |
| `qa-test-engineer` | API testing, integration testing, test scripts | API endpoint validation, e2e tests, backend QA |
| `typeorm-migration-reviewer` | Migration safety, data-loss risks, allocation invariant, money-column conventions | Pre-merge review of any file in `api/src/database/migrations/` |

### Rules for This Workflow

- **Never skip the Project Manager** — even simple-sounding requests may have cross-cutting concerns the PM needs to identify
- The PM enhances each instruction with: acceptance criteria, technical constraints from CLAUDE.md rules, and agent-specific context
- When a task spans multiple agents (e.g., "add project submission flow"), the PM breaks it into separate tasks per agent with clear API contracts between them
- The PM ensures all Project Rules below are reflected in every task it creates
- **Any new or modified TypeORM migration** must be reviewed by `typeorm-migration-reviewer` before it is merged or run in a shared environment — the PM dispatches this automatically as part of the QA gate
- **Prefer the MySQL MCP for DB inspection** — to query `prms_projects`, check schema, verify data, or validate a migration result, use the `mysql_query` MCP tool directly instead of asking the user to run SQL or paste output. The MCP is read-only by default and points at the local `docker-compose` MySQL.

### QA Gate (Mandatory)

Every wave/task must pass QA before being marked complete:

1. **After dev work completes** -> PM dispatches testing:
   - `ui-tester` — validates all UI changes (pages load, interactions work, responsive)
   - `qa-test-engineer` — validates API endpoints, database state, integration flows
2. **Testers report results to PM** with pass/fail status and bug details
3. **If bugs found** -> PM creates bug-fix tasks and dispatches to dev agents
4. **Fix -> re-test cycle** repeats until both testers confirm clean
5. **Only after QA confirms no issues** -> wave/task is marked complete and eligible for commit

## Project Rules

These rules govern ALL work in this repository. Follow them strictly.

### 1. Clean Code with Documentation
Every function, class, and non-trivial block must have clear comments explaining its purpose. Code should be well-structured with each piece of logic contained in its own component/module. Follow single-responsibility principle throughout.

### 2. Minimal External Dependencies
Do not use npm packages for small utilities unless the package saves significant development time **and** is actively maintained with a clear upgrade path. Prefer writing lightweight custom solutions for simple needs.

### 3. Smart Package Choices
When choosing dependencies, ensure they are: well-supported, actively maintained, compatible with the latest framework versions, and necessary for the task. Avoid bloated or abandoned packages.

### 4. PrimeNG as UI Foundation
Use PrimeNG components as the primary UI building blocks. Customize via the PrimeNG theming system (design tokens) to match the PRMS brand. Do not add Angular Material or other UI libraries alongside PrimeNG.

### 5. Structured Logging via Winston
All backend logging goes through the centralized Winston logger. **Rules:**
- **Never use `console.log`** in backend code — always use NestJS `Logger` (which routes through Winston automatically via `app.useLogger()`).
- **Log files** are in `api/logs/` (gitignored): `combined-*.log` (all levels), `error-*.log` (errors only), `http-*.log` (HTTP requests).
- **Request ID tracking**: Every request gets a UUID via `X-Request-ID` header and AsyncLocalStorage — all log entries include the ID.
- **Dev format**: Pretty-printed with colors. **Prod format**: JSON (for log aggregation).
- **Daily rotation**: Log files rotate daily, retained for 30 days, max 20MB per file.

### 6. TypeORM Migrations Only
Database schema changes must always go through TypeORM migrations. `synchronize: false` is enforced. Never modify the schema manually or via synchronize.

### 7. Environment Configuration
Use `@nestjs/config` with typed config files. Never hardcode secrets or environment-specific values. Use `.env.example` as the template — never commit `.env` files.

### 8. Negotiation Test Gate (Mandatory)

The negotiation workflow has a dedicated three-tier test suite that pins the **append-only timeline invariant** and every role/state rule. Any change that touches the negotiation surface MUST run these tests AND keep them updated.

**What counts as "the negotiation surface":**
- `api/src/modules/mappings/**` — service, controller, DTOs, entities, enums, gateways
- `api/src/modules/mappings/enums/negotiation-event-type.enum.ts` and any migration that widens/narrows the `mapping_negotiations.event_type` enum
- `web/src/app/features/mappings/project-negotiation-consolidated/**` — consolidated negotiation page (allocation pane, chat pane, header)
- `web/src/app/features/mappings/mapping-form/**` — draft mapping creation
- Any new endpoint, role, permission, or business rule that affects who can do what in negotiation (lock gates, mapping cap, rating requirements, removal flow, chat permissions)

**What you MUST do:**
1. **Run the suites after every change**, in order:
   ```bash
   # 1. Unit (mock-only, fast)
   cd api && npx jest src/modules/mappings/mappings.service.spec.ts

   # 2. E2E (real MySQL via supertest)
   cd api && npx jest --config test/jest-e2e.json test/negotiation.e2e-spec.ts

   # 3. Browser (Playwright + real API + real web dev server)
   cd tests/browser && PRMS_API_URL=http://localhost:3000 npx playwright test
   ```
2. **Update the specs whenever you add/change a rule, role, event type, endpoint, or state transition.** Examples:
   - New `NegotiationEventType` value → add coverage in `mappings.service.spec.ts` (which paths emit it, with what payload) AND `negotiation.e2e-spec.ts` (full-flow assertion that the row appears in the right slot).
   - New endpoint or DTO field → add a unit test for the service method, an e2e test for the HTTP path, and a browser spec if it has a UI control.
   - Role permission change → update the RBAC tests in `mappings.service.spec.ts` AND the role-bootstrap step in `tests/browser/README.md`.
   - Business rule (e.g. mapping cap, lock gate, justification min length) → unit test for the guard, e2e test that the bad request returns the right status, browser spec only if the UI surfaces it.
3. **Never delete or weaken a test to "make it pass"** — investigate the regression. If a rule legitimately changed, the test must reflect the new rule with the same level of rigor.
4. **The append-only invariant is non-negotiable.** No service method may ever `UPDATE` a row in `mapping_negotiations`. Every state change appends one (or more) new event rows. Tests assert this; if you're tempted to mutate an event row, change the design instead.

**Suite locations** (for the PM / specialist agents):
- Unit: `api/src/modules/mappings/mappings.service.spec.ts`
- E2E: `api/test/negotiation.e2e-spec.ts`
- Browser: `tests/browser/` (Playwright, ready-to-run; see `tests/browser/README.md`)

The QA gate in the agent workflow above applies on top of this rule: the PM dispatches `qa-test-engineer` (for unit + e2e) and `ui-tester` (for browser specs) on every negotiation-surface change.

## PRMS Brand & Theme

The PRMS theme matches https://risk.cgiar.org exactly (same CGIAR PRMS tool family).

### Header (matches risk.cgiar.org)
- **Layout**: Single-row dark header, NO sidebar. Logo + title left, pill-shaped nav links center, user buttons right.
- **Header background**: `linear-gradient(to right, #0f212f, #0e1e2b)` (dark navy)
- **Nav link pills**: `border-radius: 999px`, `border: 1px solid rgba(255,255,255,0.24)`, `background: rgba(255,255,255,0.08)`
- **Active nav link**: `border-color: rgba(143,177,209,0.95)`, `background: linear-gradient(135deg, #8fb1d1, #6f93b6)` with box-shadow
- **User buttons**: pill-shaped, `background: linear-gradient(to right, #436280, #30455b)`
- **Logo**: CGIAR logo from `assets/cgiar-logo.svg` (copied from risk project)
- **Logout icon**: `assets/icon-logout.svg` (copied from risk project)

### Content Area Colors
| Token | Value | Usage |
|-------|-------|-------|
| Primary (accent) | `#5569dd` | Buttons, links, active states — NOT the header |
| Primary Light | `#6e80e1` | Hover states, highlights |
| Primary Dark | `#4454b8` | Active/pressed states |
| Surface | `#ffffff` | Card backgrounds, content areas |
| Surface Ground | `#faf9f9` | Page background |
| Surface Section | `#f4f2f2` | Section backgrounds |
| Text Color | `#333333` | Primary text |
| Text Secondary | `#777777` | Secondary text, labels |
| Font Family | Poppins, sans-serif | All text |

## Database Entities

Migrations live in `api/src/database/migrations/`. The `users.role` enum supports five values: `admin`, `program_rep`, `center_rep`, `workflow_admin`, `unit_admin`.

| Table | Key Columns | Relations |
|-------|-------------|-----------|
| `users` | id, cognito_sub, email, first_name, last_name, role (enum), is_active, **center_id** (primary/default center for `center_rep`) | FK → programs, FK → centers (primary), M2M → centers via `user_centers` |
| `user_centers` | user_id, center_id, sort_order (INT, 0 = primary), created_at (DATETIME(6)). Composite PK (user_id, center_id). FKs CASCADE on both sides. Indexes on `center_id` and `(user_id, sort_order)` | Junction table for multi-center `center_rep` membership. `sort_order = 0` mirrors `users.center_id` (the primary). `UsersService.replaceUserCenters()` uses a raw `manager.query()` INSERT — TypeORM's QueryBuilder collapses `sort_order` to 0 on entity-less junctions, so the bypass is mandatory. Order is preserved on PATCH via atomic delete-all + reinsert. Service deduplicates incoming `centerIds` (first occurrence wins) and logs a warning when duplicates are dropped. |
| `centers` | id, clarisa_id, code, name, acronym, institution_id, synced_at | Synced from CLARISA |
| `programs` | id, clarisa_id, official_code, name, synced_at | Synced from CLARISA |
| `countries` | id, clarisa_id, iso_alpha_2, iso_alpha_3, name, region, synced_at | Synced from CLARISA |
| `action_areas` | id, clarisa_id, name, description, color, synced_at | Synced from CLARISA |
| `projects` | id, code (unique), name, description, summary, results, start_date, end_date, total_budget, remaining_budget, funding_source (enum), funder, status (enum), **negotiation_locked** (bool) | FK → centers, FK → users (created_by), M2M → countries |
| `project_countries` | project_id, country_id | Join table |
| `project_mappings` | id, project_id, program_id, allocation_percentage, status (`draft` / `negotiating` / `agreed` / `removed`), center_agreed, program_agreed, initiated_by, `complementarity_rating` / `efficiency_rating` (enum `high`/`medium`/`low`, nullable), `removal_requested` + `removal_requested_by/_at` + `removal_justification`. Legacy `rejection_reason`, `submitted_by/at`, `reviewed_by/at` retained, unused. **Ratings are center-side only**: required on create and on every center-side allocation edit; program-rep endpoints carry no rating fields. **Program reps cannot remove unilaterally** — they raise a request via `removal_*` columns; center accepts via `/remove` or rejects via `/decline-removal`. | FK → projects, programs, users. UNIQUE(project_id, program_id) |
| `mapping_negotiations` | id, project_mapping_id, event_type (`initiated` / `counter_proposed` / `agreed` / `reopened` / `removed` / `flagged_for_assistance` / `negotiation_started` / `removal_requested` / `removal_declined` / `locked` / `rating_updated`), actor_user_id, allocation_snapshot, justification, created_at | **Append-only audit trail.** No service method may ever UPDATE a row here — every state change appends new event row(s). `locked` writes one row per active mapping when the project round locks (mirrors `reopened`). `rating_updated` written when a center-side allocation edit changes only ratings. Consolidated chat loads events for ALL project mappings (including removed) so history survives removal. |
| `project_negotiation_messages` | id, project_id, author_user_id, message, created_at | Free-text chat thread on the consolidated negotiation page |
| `project_audit_events` | id, project_id, actor_user_id, actor_role, event_type (`field_edited` / `snapshot_republished` / `project.excluded` / `project.unexcluded`), field_name, value_before (JSON), value_after (JSON), justification, created_at | Append-only audit log. One row per changed field. Decimal fields stay as strings in JSON to avoid IEEE 754 precision loss. |
| `published_snapshots` | id, version_label, description, published_at, published_by, created_by_role (admin / unit_admin), project_count, total_budget, summary_stats (JSON), is_active | Frozen snapshot of the active portfolio |
| `project_exclusions` | id, project_id, center_id, excluded_by_user_id, reason (NOT NULL), excluded_at. UNIQUE(project_id, center_id) | Per-center hide-from-default-view. Applied by `ProjectExclusionService`; filtered out of center-rep-scoped queries in projects, dashboard, and mappings unless `showExcluded=true`. Writes audit events on exclude/unexclude. |
| `system_settings` | id (TINYINT UNSIGNED, CHECK id=1), email_enabled, deadline_enabled, deadline_date (DATE, nullable), updated_at, updated_by (FK users.id ON DELETE SET NULL) | Singleton row holding global admin toggles. Seeded by migration. `deadline_date` is DATE (not DATETIME) and round-trips as `YYYY-MM-DD` string to avoid TZ shifting. Read by any authenticated user (`GET /settings`); written only by admin (`PATCH /settings`). **`email_enabled` is the admin kill switch for outbound mail**: when `false`, `EmailsDispatchService` checks the toggle at the top of every tick and skips leasing entirely (queued rows pile up until re-enabled). `clearStuckLeases()` still runs so re-enabling doesn't strand `sending` rows. The test-send endpoint (`POST /admin/emails/test-send`) bypasses this gate at enqueue time but the row will only actually publish once `email_enabled` is back on. The broker connection itself is independently gated by `NOTIFICATIONS_ENABLED` / `NOTIFICATIONS_DRY_RUN` env flags on `NotificationsModule`. `deadline_enabled` / `deadline_date` are storage-only — no enforcement on the negotiation workflow yet. `MappingReminderService` intentionally does NOT read this toggle — reminder rows are always generated on schedule so no reminders are lost during a kill-switch window. |
| `emails` | id (BIGINT UNSIGNED), to_user_id (INT nullable, FK users.id ON DELETE SET NULL), to_email (denormalized at queue time), subject, body (MEDIUMTEXT), body_format (enum `text`/`html`), status (enum `queued`/`sending`/`sent`/`failed`), priority (TINYINT, default 5), attempts, max_attempts, last_error, locked_at, locked_by, next_attempt_at, sent_at, queued_at, created_by_user_id (FK users.id ON DELETE SET NULL), template_key, metadata (JSON). Indexes: `(status, next_attempt_at)` for worker poll, `to_user_id`, `queued_at` | Queue table for transactional email. Admin Email Management UI (`/admin/emails`) lists/filters/views rows and can retry failed ones. **Append-only from the admin surface** — admin cannot edit or delete rows; retry just resets `status` to `queued` + clears `last_error` + leaves `attempts` unchanged (protects against admin-triggered infinite loops on broken recipients). An email-dispatch cron worker leases rows (`locked_at`/`locked_by`), publishes them via `NotificationsService.send(...)`, and transitions `queued` → `sending` → `sent` (or `failed` with exponential `next_attempt_at` backoff). `EmailsService.enqueue(...)` is the internal API other modules call to send mail; no HTTP enqueue endpoint exists. Reminder jobs use `metadata.reminderDate` (YYYY-MM-DD) + `template_key` for daily idempotency. |

**Critical business rule**: Before a Center Rep can lock a project round (`POST /mappings/projects/:projectId/lock`), every non-removed mapping must be in `agreed` status AND `SUM(allocation_percentage)` of non-removed mappings must equal 100. Once locked, all negotiation actions are rejected at the service layer until `reopen` is called. Enforced with pessimistic locking on the project row.

**Mapping cap**: A project can have at most **3 active (non-removed) mappings**. Enforced in `MappingsService` on `create()` and `addProgramToProject()` via `assertMappingCapNotExceeded()` — throws 400. Removed mappings don't count, so a center can swap programs in/out. CSV / Signalling imports intentionally bypass the cap so legacy portfolios still load. The consolidated UI hides the Add button and shows a "Max 3 programs reached" hint when the cap is hit.

## API Endpoints

Routes are mounted at root on the API (no global `/api` prefix). Browsers hit `/api/...` via the web container's nginx, which strips the prefix before proxying.

### Auth (`/auth/`)
- `GET /login` — returns Cognito authorization URL (public)
- `POST /callback` — exchanges code for tokens (public)
- `POST /refresh` — refreshes access token via cookie (public)
- `POST /logout` — revokes token, clears cookie (public)
- `GET /me` — returns current user (JWT required)
- `POST /dev-login`, `GET /dev-token` — dev-only auth bypass (NODE_ENV=development)

### Projects (`/projects/`)
- `GET /` — paginated list with search/filters (any auth). For center_rep: excluded projects are hidden by default; pass `?showExcluded=true` to include them (response items carry `exclusion: { reason, excludedAt, excludedBy }` when excluded). Other roles: no filtering, no exclusion data on response.
- `GET /:id` — single project with relations (any auth). For center_rep/admin: response includes `exclusion` field (null when not excluded).
- `POST /` — create project (admin)
- `PATCH /:id` — update project, full surface (admin) — writes one `project_audit_events` row per changed field; optional `justification`
- `PATCH /:id/metadata` — constrained metadata edit (admin, unit_admin, center_rep) — accepts only the unit-admin whitelist + required `justification` ≥ 5 chars; allowed even when `negotiation_locked = true`. Center reps are restricted to projects in their own center (`actor.centerId === project.centerId`); admin and unit_admin can edit any project
- `GET /:id/audit` — paginated audit history (admin, unit_admin, workflow_admin); response: `{ data: ProjectAuditEvent[], total, page, limit }`, ordered most-recent first, default `limit = 50`
- `POST /:id/exclude` — exclude a project from the caller's center's default view (center_rep restricted to own center; admin excludes under project's owning center). Body: `{ reason: string }` (min 5 chars). 409 if already excluded. Writes `project.excluded` audit event.
- `POST /:id/unexclude` — remove an existing exclusion (center_rep own center; admin). 404 if no exclusion exists. Writes `project.unexcluded` audit event.
- `DELETE /:id` — archive project (admin)

### Mappings — Negotiation Workflow (`/mappings/`)
All endpoints require auth. Project-level `negotiation_locked` is enforced at the service layer — locked projects reject every mutating action below.

Queries:
- `GET /` — role-filtered list (scoped to user's center / program)
- `GET /:id` — single mapping
- `GET /:id/negotiations` — ordered negotiation event thread for one mapping
- `GET /projects/:projectId/allocation` — allocation summary
- `GET /projects/:projectId/review-summary` — review details (admin, center_rep)
- `GET /projects/:projectId/consolidated` — full two-pane view (header + lock state + all active mappings + negotiation thread + chat)

Creation:
- `POST /` — create draft mapping (center_rep). Body must include `complementarityRating` and `efficiencyRating` (center-set, required)
- `POST /projects/:projectId/add-program` — add program from the consolidated page (center_rep, workflow_admin). Body must include both ratings (center-set, required)

Per-mapping negotiation actions:
- `POST /:id/open` — open negotiation on a draft (center_rep)
- `POST /:id/counter-propose` — submit a counter-proposal (center_rep, program_rep, workflow_admin) — resets both agreement flags and implicitly agrees on behalf of the proposer. Allowed on `negotiating` AND `agreed` mappings (`draft` / `removed` reject); when the row was `agreed`, the counter reverts it to `negotiating` so the counter-party can re-agree — this is the path to unblock an over-allocated round where both sides agreed on terms summing > 100. Body is `{ proposedAllocation, justification }` — ratings are NOT collected here
- `POST /:id/agree` — mark agreement on current terms (center_rep, program_rep, workflow_admin) — blocked on replying to your own proposal. Body is empty — ratings are NOT collected here
- `POST /:id/remove` — remove a program from negotiations with justification (center_rep, workflow_admin, program_rep). For program_rep this is **403** — they must use `/request-removal`. When a request is pending, the center calling this endpoint accepts it (the program rep's reason is merged into the audit event)
- `POST /:id/request-removal` — program rep raises a removal request (justification ≥ 10 chars). Mapping stays in current state with `removal_requested = true` until the center side resolves it. **409** if a request is already pending
- `POST /:id/decline-removal` — center side rejects a pending removal request (center_rep, workflow_admin); optional `reason` is recorded on a `removal_declined` event so the program rep sees why
- `PATCH /:id/allocation` — inline allocation edit on the consolidated page (center_rep, program_rep, workflow_admin) — resets agreement flags + appends audit event. Center-side actors (center_rep / workflow_admin) MUST include both `complementarityRating` and `efficiencyRating`; program-rep edits omit them

Project-level actions:
- `POST /projects/:projectId/lock` — lock the round (owning center_rep or workflow_admin); requires all non-removed mappings `agreed` and sum = 100
- `POST /projects/:projectId/reopen` — reopen the round (owning center_rep or workflow_admin); reverts agreed mappings to `negotiating`
- `POST /projects/:projectId/chat` — post a free-text chat message on the project negotiation thread (owning center_rep, participating program_rep, or workflow_admin)

### Reference Data (root)
- `GET /centers`, `GET /programs`, `GET /countries`, `GET /action-areas` — cached 5min (any auth)

### Admin (`/admin/`)
- `POST /sync-clarisa` — trigger CLARISA sync (admin)
- `POST /import-csv` — import TOC_Projects.csv (admin)
- `POST /reimport-csv` — re-run import (admin)
- `POST /admin/imports/bulk` — multi-file upload (admin). Auto-detects file type by filename + header signature: TOC, 4.1 Project Info, 4.3 Project Budget, **Signalling**.
  - **Signalling import semantics** (per row, attributed to synthetic `system@prms.cgiar.org` user):
    - `Increased` / `Decreased` → appends `initiated` + `counter_proposed` (no auto-agreed). Mapping left `negotiating` with `programAgreed=true` / `centerAgreed=false` so only the center needs to agree. Project force-**unlocked**.
    - `Keep as is` → appends `initiated` only. Project force-**locks** unless any row on it is Increased/Decreased.
    - `Removed` → appends `initiated` + `removed`. Does not affect lock direction.
    - Comments: Increased/Decreased → on `counter_proposed.justification`; `Removed` → on `removed` event; `Keep as is` (non-empty) → posts one `project_negotiation_messages` row per row, formatted `[Signalling Import — <programOfficialCode>] <comment>`, bypassing the lock guard.
    - Re-import wipes prior system-authored chat rows on each touched project. **Bypasses the 3-mapping cap.**

### Users (`/users/`)
- `GET /` — list all users (admin). Response includes `centerIds: number[]` (ordered, primary first) and resolved `centers: Center[]` on each user.
- `POST /` — create user (admin). Body accepts `centerIds: number[]` (1..N) for `center_rep` role. First element = primary (writes to `users.center_id` + `user_centers.sort_order = 0`). Service deduplicates and validates every id exists. Atomic transaction across `users` + `user_centers`.
- `PATCH /:id` — update role/program/`centerIds`/active (admin). When `centerIds` is provided, performs atomic delete-all + reinsert preserving submission order; `users.center_id` updated to `centerIds[0]`. Audit log records `centerIds` diff alongside `centerId`. Omitting `centerIds` leaves junction rows untouched (partial update).
- `DELETE /:id` — deactivate user (admin). Does NOT delete `user_centers` rows — reactivating restores memberships.

### Dashboard (`/dashboard/`)
- `GET /summary` — role-aware aggregate stats (any auth)
- `GET /allocation-status` — projects by allocation % + agreed/locked breakdown (any auth)
- `GET /recent-activity` — latest mapping/negotiation events (any auth)

### Published Snapshots (`/published/`)
- `POST /snapshots` — publish a new snapshot of the active portfolio (admin, unit_admin); records the actor's role on `published_snapshots.created_by_role`
- `GET /snapshots` — list all snapshots (admin, unit_admin)
- `GET /latest` — active snapshot metadata (public)
- `GET /latest/projects` — paginated published projects from active snapshot (public)
- `GET /latest/projects/:id` — single published project from active snapshot (public)

### Notifications (no HTTP surface)
`NotificationsModule` is a producer-only integration with the CGIAR central Notification Microservice over RabbitMQ (`Transport.RMQ`, routing key `send`). Inject `NotificationsService` and call `send({ to, cc?, bcc?, subject, text?, html? })`; the service builds the documented `{ auth, data: { from, emailBody: { …, message: { text, socketFile } } } }` payload and base64-encodes `html` into `socketFile`. Two-layer kill switch: `NOTIFICATIONS_ENABLED=false` (default) disables the module entirely (no client created, returns `disabled`); `NOTIFICATIONS_DRY_RUN=true` (default when enabled) builds + logs the payload but skips `client.emit`. Broker errors are swallowed and logged so a notification outage never aborts the caller's primary action. No business flow currently calls it — wiring it into mapping / negotiation events is a follow-up.

### Settings (`/settings`)
Singleton system-wide config backing the admin **Settings** page (`/admin/settings`). `email_enabled` is the admin kill switch for outbound mail: `EmailsDispatchService.dispatchTick()` reads it on every cron run and skips leasing when `false` (rows accumulate in `queued` until re-enabled). The broker connection is independently gated by `NOTIFICATIONS_ENABLED` / `NOTIFICATIONS_DRY_RUN` env flags on `NotificationsModule` (see above). Deadline enforcement on the negotiation workflow is still a follow-up.
- `GET /settings` — any authenticated user (so center reps can surface the deadline in their UI later). Response: `{ emailEnabled, deadlineEnabled, deadlineDate, updatedAt, updatedBy }`. `deadlineDate` is `YYYY-MM-DD` or null.
- `PATCH /settings` — admin only. Validation: if `deadlineEnabled=true`, `deadlineDate` is required AND must be strictly in the future (today rejects). If `deadlineEnabled=false`, any submitted `deadlineDate` is force-cleared to null.

### Scheduled Jobs

| Job | Schedule | Module | Kill switches |
|---|---|---|---|
| Email dispatcher | `*/2 * * * *` (every 2 min) | `EmailsModule / EmailsDispatchService` | `system_settings.email_enabled`, `NOTIFICATIONS_ENABLED` |
| Center mapping reminders | `0 9 * * *` (daily 09:00 UTC) | `EmailsModule / MappingReminderService` | `system_settings.deadline_enabled`, deadline passed, center ≥ 90% (NOTE: `system_settings.email_enabled` does NOT gate generation — it gates dispatch only, so rows still enqueue when emails are paused and publish automatically once re-enabled) |

**Reminder cadence logic** (`MappingReminderService`):
- `deadline_date - today > 3 days` → weekly, Mondays only (UTC)
- `deadline_date - today ≤ 3 days` → daily
- Template key: `center_mapping_reminder`
- Idempotency: skips if `emails` row already exists for `(to_user_id, template_key, metadata.reminderDate = today)`
- Skip conditions: `deadline_enabled=false`, deadline passed, center `mappedPercent ≥ 90`, `totalBudgetYear = 0`, no active `center_rep` users for that center
- Recipients: all active `center_rep` users joined via `user_centers` (multi-center reps receive one email per center they belong to)
- Subject uses center acronym; body salutation uses center full name

### Email Management (`/admin/emails`)
Admin-only queue view + retry surface for the `emails` table. Sending is intentionally a separate follow-up (cron worker not yet built).
- `GET /admin/emails` — paginated list with filters (`status`, `toUserId`, `search` over subject + to_email, `dateFrom` / `dateTo` on `queued_at`, `sortBy` ∈ `queued_at`/`sent_at`/`status`/`attempts`, `sortDir`). Response items exclude `body` and `last_error` for perf.
- `GET /admin/emails/:id` — full row including `body`, `bodyFormat`, `lastError`, `lockedAt`, `lockedBy`, `templateKey`, `metadata`.
- `POST /admin/emails/:id/retry` — only allowed when current `status='failed'`; other statuses 400 with `code: 'EMAIL_NOT_RETRIABLE'`. Resets `status` → `queued`, clears `last_error`/`locked_at`/`locked_by`, sets `next_attempt_at = NOW()`. **Does not reset `attempts`** — protects against admin-driven infinite loops.
- `POST /admin/emails/test-send` — body `{ toUserId }`. Enqueues a fixed-template HTML email to the selected user via `EmailsService.enqueue(...)`. **Bypasses `system_settings.email_enabled`** at enqueue time (the whole point is to verify the pipeline regardless of the global toggle), though the dispatcher still won't publish the row until the toggle is on. Inactive users are allowed; only missing email throws 400. Returns `{ id, toUserId, toEmail, subject, status: 'queued' }`. Surfaced via the "Send Test Email" card on `/admin/settings`.
- `DELETE /admin/emails/queued` — admin-only bulk purge. Hard-DELETEs every row currently in `status='queued'`. Returns `{ deleted: number }`. **Only `queued` rows are touched** — `sending` (mid-flight), `sent` (audit log), and `failed` (retry candidates) are immune. Idempotent (empty queue → `{ deleted: 0 }`). Implementation SELECTs ids first inside a transaction so the Winston audit log line names the exact rows removed (truncated to first 50 ids + count). Surfaced as a "Purge queued (N)" button on the `/admin/emails` toolbar; the count comes from a cheap `?status=queued&limit=1` call and refreshes after every list reload.

`EmailsService.enqueue(...)` is the **internal API** other modules call to send mail (e.g. a future negotiation-counter-proposal notification). No HTTP enqueue endpoint — bodies must be rendered by the caller. See the JSDoc on the service method for the contract. Current internal callers: `MappingReminderService` (center mapping reminders — template key `center_mapping_reminder`, daily 09:00 UTC cron).

