# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PRMS Projects Registry is a project management and registry tool for CGIAR's Performance and Results Management System (PRMS). It enables tracking, managing, and reporting on research projects across the CGIAR portfolio.

**Core workflow**: Admin creates projects → Center Rep initiates mappings to programs with % allocation → Center and Program Reps negotiate via a chat/counter-propose thread → when all mappings are agreed and total = 100%, the Center Rep locks the project round (project-level `negotiation_locked` flag is the single source of truth).

## Repository Structure

```
api/    NestJS backend — src/{common,config,database/migrations,modules/{auth,users,projects,mappings,reference-data,clarisa,import,dashboard,...}}, test/, .env.example
web/    Angular 21 + PrimeNG v21 — src/app/{core (services, interceptors, guards),features (lazy: dashboard, projects, mappings, users, auth),shared,layout}
docker-compose.yml (dev), docker-compose.prod.yml, nginx/, logs/, media/, .claude/, CLAUDE.md
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

### Deployment

| Remote | Repo | Deploy branch | Env |
|---|---|---|---|
| `origin` | `CodeObia/PRMS-Projects-Registry` | `development` | Dev (CodeObia) |
| `ciat` | `AllianceBioversityCIAT/onecgiar-clarisa-project-mapping` | `main` | Prod (CIAT) |

Local work on `master`. Deploys via PR + merge commit (never squash/rebase — preserve commit history on both deploy branches).

- **`/push-to-development`** — `master` → `origin/development` (PR + merge). Never touches CIAT.
- **`/push-to-production`** — `master` → `origin` AND `ciat`; opens `ciat master→main` PR; merges.

Preflight checks (on `master`, no tracked-but-uncommitted changes, commits ahead of target) abort loudly. Untracked files (`??`) are ignored.

**Default push target is `origin`** — never push to `ciat` manually; always go through `/push-to-production` for the audit trail.

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
| External API | CLARISA (Centers, Programs, Countries, Action Areas), MEL TOC (Areas of Work, Outcomes, Outputs) | — |
| Logging | Winston + winston-daily-rotate-file | — |
| Container | Docker + Docker Compose | — |
| Node.js | 22 LTS | — |

### Key Technical Notes
- **Node.js 22 required** — use `nvm use 22` (`.nvmrc` in root)
- **Angular 21 polyfills**: Must add `"polyfills": ["zone.js"]` to `angular.json` build options
- **Angular 21 serve**: `"ssl": true` and `"allowedHosts": ["localhost"]` in angular.json serve options
- **PrimeNG v21 naming changes**: `Select` (not Dropdown), `DatePicker` (not Calendar), `Textarea` from `primeng/textarea` (not `InputTextareaModule`), `p-select`/`p-datepicker` in templates, `optionLabel` (not `[field]`) on AutoComplete
- **PrimeNG overlays — `appendTo="body"` needed in three places**: (1) `app.config.ts` sets `providePrimeNG({ overlayOptions: { appendTo: 'body' } })` — covers `p-select`/`p-multiselect`/`p-autocomplete`/`p-cascadeselect`/`p-treeselect`/`p-colorpicker`/`p-password`. (2) **`p-datepicker` does NOT** consume global options — pass `appendTo="body"` on every instance or its calendar gets clipped. (3) **`p-table` paginator dropdown is separate** — pass `paginatorDropdownAppendTo="body"` on every paginated table.
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
- **JWT carries `centerIds: number[]`** — ordered list of centers a `center_rep` belongs to (primary first, `user_centers.sort_order` ASC). `[]` for non-center-rep roles. `users.center_id` = primary = `centerIds[0]`. `GET /auth/me` returns resolved `centers: Center[]`.
- **Active-center overlay** — multi-center reps switch via header `CenterSwitcherComponent`. Auth interceptor attaches `X-Active-Center: <id>` to all API requests (except `/auth/*`) when `centerIds.length > 1`. Backend `ActiveCenterInterceptor` validates against `req.user.centerIds` and overlays `req.user.centerId`. Forged ids → **403 `{ code: 'ACTIVE_CENTER_INVALID' }`**. Empty `centerIds` + header → silent pass-through.
- **Frontend graceful recovery** — on `ACTIVE_CENTER_INVALID` the error interceptor refreshes `/auth/me`, calls `AuthService.resetActiveCenterToFirst()`, toasts, retries once (loop guard via `HttpContextToken`). `activeCenterId` persisted to `localStorage.prms.activeCenterId`.
- **Staleness window**: ≤15min after an admin reassigns centers (JWT still carries old `centerIds` until next refresh); stale `X-Active-Center` triggers the recovery flow above.

### Dev Login (Browser Testing with Playwright)
Bypasses Cognito (dev-only, `NODE_ENV=development`):
1. Start test server (HTTP): `npx ng serve --configuration test` (port 4202)
2. Navigate to `http://localhost:4202/auth?dev=admin@codeobia.com` → calls `GET /auth/dev-token?email=...` → JWT + refresh cookie → redirects to `/dashboard`
3. Ensure `CORS_ORIGIN` includes `http://localhost:4202`
4. **Use in-app nav** — full-page `goto` loses the in-memory token; re-auth first for cross-route navigation

Endpoints: `POST /auth/dev-login` (body `{ email }`), `GET /auth/dev-token?email=...`.

**Playwright artifacts (MANDATORY)** — all screenshots, snapshots, traces go in `playwright/` at repo root (gitignored). Always pass `filename: playwright/<name>.png` to `browser_take_screenshot`. Applies to all subagents.

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
| **Admin** | CRUD projects, manage users (assign roles), CSV import, CLARISA sync, view all data, exclude/unexclude any project. **Read-only on negotiation surface** — `workflow_admin` is the arbiter, not admin. **Cannot edit Anaplan-sourced fields** (`code`, `centerId`, `startDate`, `endDate`, `fundingSource`, `funder`, 2026 Anaplan block) — only CSV import overwrites them. |
| **Program Rep** | Negotiation on mappings to their program: agree, counter-propose allocation, chat, **request removal** (cannot remove unilaterally). Cannot create mappings or lock rounds. **Does not set complementarity / efficiency ratings**. |
| **Center Rep** | Initiate mappings for projects in their center; open/counter-propose/agree/remove during negotiation; accept/decline program-rep removal requests; chat; **lock** / **reopen** rounds (when all mappings agreed + total = 100%). **Sets complementarity and efficiency ratings** on create and every center-side allocation edit. Edits non-Anaplan project metadata via `PATCH /projects/:id/metadata`. **Exclude/unexclude projects in own center**. **Multi-center**: admin assigns 1..N centers; rep switches via header `CenterSwitcherComponent`; active center scopes every request; `centerIds[0]` is primary default. |
| **Workflow Admin** | System-office arbiter: full negotiation rights on every project regardless of center. Lands on `/needs-assistance` queue (auto-flagged after a program rep's 2nd counter-proposal). Cannot manage projects, users, or run admin-only data ops. |
| **Unit Admin** (PPU/PCU) | Edit whitelisted project metadata on **any** project regardless of `negotiation_locked` state. Trigger published-snapshot republishes. View project audit history. No user/mapping/negotiation management. |
| **No role** (null) | Read-only viewer. `GET /projects` + `GET /projects/:id` only; all mutating endpoints return **403**. Frontend lands on `/projects`; planning UI tiles hidden (admin / center_rep only). |

- Roles stored in `users.role` column (nullable — new users have no role until admin assigns one; they get the **No role** view above until an admin assigns one via Users page)
- `@Roles(UserRole.ADMIN)` decorator + global `RolesGuard` (APP_GUARD)
- `@Public()` decorator bypasses JWT auth (used on auth endpoints, health check)

## Agent Workflow

**All user instructions must flow through `tech-project-manager` first.** PM analyzes, clarifies, breaks into actionable tasks, then dispatches to specialists.

| Agent | Receives tasks about |
|-------|---------------------|
| `tech-project-manager` | Project planning, specs, ambiguous requirements, multi-agent coordination |
| `angular-frontend-expert` | Frontend components, pages, UI/UX, Angular routing, forms, styling |
| `nestjs-backend-expert` | API endpoints, DB schema, services, integrations, backend logic |
| `devops-docker-jenkins` | Dockerfiles, pipelines, docker-compose, deployment configs |
| `ui-tester` | Post-implementation UI verification, interaction testing |
| `qa-test-engineer` | API endpoint validation, e2e tests, backend QA |
| `typeorm-migration-reviewer` | Pre-merge review of any `api/src/database/migrations/` file |

**Rules:**
- Never skip the PM. Multi-agent tasks get split with clear API contracts between them.
- Any new/modified TypeORM migration → `typeorm-migration-reviewer` (PM dispatches automatically).
- **Prefer the MySQL MCP for DB inspection** — use `mysql_query` MCP directly (read-only, points at docker-compose MySQL) instead of asking the user.

**QA Gate (Mandatory)**: After dev work, PM dispatches `ui-tester` (UI changes) + `qa-test-engineer` (APIs/DB/integration). Bugs → fix → re-test until clean. Only then is the task complete + eligible for commit.

## Project Rules

1. **Clean code + comments** — explain non-trivial logic; single-responsibility throughout.
2. **Minimal dependencies** — prefer lightweight custom code over npm packages for small utilities.
3. **Smart packages** — only well-maintained, framework-compatible, necessary dependencies.
4. **PrimeNG only** — no Angular Material or competing UI libs. Customize via theming tokens.
5. **Winston logging** — never use `console.log` in backend; use NestJS `Logger` (routed through Winston). Files in `api/logs/` (gitignored): `combined-*`, `error-*`, `http-*`. Every request gets a UUID via `X-Request-ID` + AsyncLocalStorage. Dev = pretty; prod = JSON. Daily rotation, 30d retention, 20MB/file.
6. **TypeORM migrations only** — `synchronize: false` enforced; never modify schema manually.
7. **`@nestjs/config` + typed configs** — never hardcode secrets; `.env` is gitignored, `.env.example` is the template.

### 8. Negotiation Test Gate (Mandatory)

Three-tier test suite pins the **append-only timeline invariant** and every role/state rule. Any change to the negotiation surface MUST run these AND keep them updated.

**Negotiation surface:**
- `api/src/modules/mappings/**` (service, controller, DTOs, entities, enums, gateways)
- Migrations widening/narrowing `mapping_negotiations.event_type`
- `web/src/app/features/mappings/project-negotiation-consolidated/**` and `mapping-form/**`
- Any role/permission/business rule affecting negotiation (lock gates, mapping cap, ratings, removal, chat)

**Required workflow:**
1. Run the suites in order after every change:
   ```bash
   cd api && npx jest src/modules/mappings/mappings.service.spec.ts                    # Unit
   cd api && npx jest --config test/jest-e2e.json test/negotiation.e2e-spec.ts          # E2E (real MySQL)
   cd tests/browser && PRMS_API_URL=http://localhost:3000 npx playwright test           # Browser
   ```
2. Update specs whenever you add/change a rule, role, event type, endpoint, or state transition. New event types → unit + e2e coverage. New endpoint/DTO field → unit + e2e + browser (if UI). Role/business-rule changes → RBAC tests + guard test + correct error status.
3. Never delete or weaken a test to make it pass. Investigate the regression first.
4. **Append-only invariant is non-negotiable** — no service method may UPDATE `mapping_negotiations`. Every state change appends new event row(s). Change the design before mutating.

Suite locations: unit `api/src/modules/mappings/mappings.service.spec.ts`, e2e `api/test/negotiation.e2e-spec.ts`, browser `tests/browser/` (see `README.md`). The agent-workflow QA gate dispatches `qa-test-engineer` (unit + e2e) and `ui-tester` (browser) on every negotiation-surface change.

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
| `user_centers` | user_id, center_id, sort_order (INT, 0 = primary), created_at. Composite PK (user_id, center_id). FKs CASCADE both sides. Indexes on `center_id` and `(user_id, sort_order)` | Junction for multi-center `center_rep`. `sort_order = 0` mirrors `users.center_id`. `UsersService.replaceUserCenters()` uses raw `manager.query()` INSERT (TypeORM QueryBuilder collapses `sort_order` to 0 on entity-less junctions). Atomic delete-all + reinsert on PATCH preserves order. Service deduplicates incoming `centerIds`. |
| `centers` | id, clarisa_id, code, name, acronym, institution_id, synced_at | Synced from CLARISA |
| `programs` | id, clarisa_id, official_code, name, synced_at | Synced from CLARISA |
| `countries` | id, clarisa_id, iso_alpha_2, iso_alpha_3, name, region, synced_at | Synced from CLARISA |
| `action_areas` | id, clarisa_id, name, description, color, synced_at | Synced from CLARISA |
| `toc_aows` | id, node_id (WP graph id), clarisa_toc_id, acronym, wp_official_code, name, program_id (FK programs CASCADE), synced_at. UNIQUE `(program_id, node_id)` | Areas of Work from MEL TOC API. One row per AOW per program. `wp_official_code` is `SP01-AOW03` style. |
| `toc_outcomes` | id, node_id, title, description, outcome_type (`intermediate`/`portfolio`), related_node_id, aow_id (FK toc_aows SET NULL, nullable), program_id (FK programs CASCADE), synced_at. UNIQUE `(program_id, node_id)` | `intermediate` = OUTCOME (IOC1…), `portfolio` = EOI (2030-OC1…). `aow_id` from node's `group` (sometimes missing). |
| `toc_outputs` | id, node_id, title, description, type_of_output, related_node_id, aow_id (FK toc_aows SET NULL, nullable), program_id (FK programs CASCADE), synced_at. UNIQUE `(program_id, node_id)` | TOC Outputs (HLOs). `aow_id` resolved from node's `group` (rarely null in practice). |
| `projects` | id, code (unique), name, description, summary, results, start_date, end_date, total_budget, remaining_budget, funding_source (enum), funder, status (enum), **negotiation_locked** (bool), **is_global** (bool — Location of Benefit only) | FK → centers, FK → users (created_by), M2M → countries (Location of Benefit), M2M → countries (Country of Implementation) |
| `project_countries` | project_id, country_id | Join table — **Location of Benefit** (beneficiary geography). Cleared when `projects.is_global = true`. |
| `project_implementation_countries` | project_id, country_id. Composite PK, FKs CASCADE. | **Country of Implementation** (physical delivery). Independent of `is_global`. Editable via `PATCH /projects/:id` (admin) or `PATCH /projects/:id/metadata` (unit_admin, center_rep). |
| `project_mappings` | id, project_id, program_id, allocation_percentage, status (`draft`/`negotiating`/`agreed`/`removed`), center_agreed, program_agreed, initiated_by, `complementarity_rating`/`efficiency_rating` (`high`/`medium`/`low`, nullable), `removal_requested` + `removal_requested_by/_at` + `removal_justification`. Legacy `rejection_reason`, `submitted_by/at`, `reviewed_by/at` retained, unused. **Ratings center-side only** (required on create + center-side allocation edits). **Program reps cannot remove unilaterally** — request via `removal_*` columns; center accepts via `/remove` or rejects via `/decline-removal`. | FK → projects, programs, users. UNIQUE(project_id, program_id) |
| `mapping_negotiations` | id, project_mapping_id, event_type (`initiated`/`counter_proposed`/`agreed`/`reopened`/`removed`/`flagged_for_assistance`/`negotiation_started`/`removal_requested`/`removal_declined`/`locked`/`rating_updated`/`toc_updated`), actor_user_id, allocation_snapshot, justification, created_at | **Append-only audit trail.** No service method may UPDATE rows — every state change appends new event(s). `locked` writes one row per active mapping when project round locks. `rating_updated` for center-side rating-only edits. `toc_updated` for program-side TOC-contribution edits (no allocation/agreement change). Consolidated chat loads events for ALL project mappings (including removed) so history survives removal. |
| `mapping_toc_links` | id, project_mapping_id (FK CASCADE), link_type ENUM(`aow`/`output`/`outcome`), toc_id (polymorphic — refs `toc_aows.id` / `toc_outputs.id` / `toc_outcomes.id` per `link_type`, no FK), created_by_user_id (FK SET NULL), created_at. UNIQUE `(project_mapping_id, link_type, toc_id)`. | Per-mapping TOC contribution. Program rep declares which AOWs / High-Level Outputs / Intermediate Outcomes the program delivers against. `agree()` gate (program-side only): **≥1 AOW AND (≥1 Output OR ≥1 Intermediate Outcome)** else 400 `{ code: 'TOC_LINKS_REQUIRED', statusCode: 400, message }`. Editable on `negotiating`/`agreed`; rejected on `draft`/`removed`/locked-project. Edit appends one `toc_updated` event; does NOT reset agreement flags. Outcome rows filtered to `outcome_type='intermediate'` (no portfolio EOIs). Cross-program ids rejected with explicit list. Grandfathered: pre-existing `agreed` mappings without links stay agreed; gate fires only on new `agree()` calls. |
| `project_negotiation_messages` | id, project_id, author_user_id, message, created_at | Free-text chat thread on the consolidated negotiation page |
| `project_audit_events` | id, project_id, actor_user_id, actor_role, event_type (`field_edited` / `snapshot_republished` / `project.excluded` / `project.unexcluded`), field_name, value_before (JSON), value_after (JSON), justification, created_at | Append-only audit log. One row per changed field. Decimal fields stay as strings in JSON to avoid IEEE 754 precision loss. |
| `published_snapshots` | id, version_label, description, published_at, published_by, created_by_role (admin / unit_admin), project_count, total_budget, summary_stats (JSON), is_active | Frozen snapshot of the active portfolio |
| `project_exclusions` | id, project_id, center_id, excluded_by_user_id, reason (NOT NULL), excluded_at. UNIQUE(project_id, center_id) | Per-center hide-from-default-view. Applied by `ProjectExclusionService`; filtered out of center-rep-scoped queries unless `showExcluded=true`. Writes audit events on exclude/unexclude. |
| `system_settings` | id (TINYINT, CHECK id=1), email_enabled, deadline_enabled, deadline_date (DATE, nullable), updated_at, updated_by (FK users.id SET NULL) | Singleton admin-toggle row. `deadline_date` is DATE (round-trips as `YYYY-MM-DD` to avoid TZ shifting). Read by any auth user (`GET /settings`), written by admin (`PATCH /settings`). **`email_enabled` is the admin kill switch for outbound mail**: when `false`, `EmailsDispatchService` skips leasing every tick (queued rows pile up; `clearStuckLeases()` still runs). `POST /admin/emails/test-send` bypasses the gate at enqueue but the dispatcher still waits for the toggle. Broker independently gated by `NOTIFICATIONS_ENABLED` / `NOTIFICATIONS_DRY_RUN` env flags. `deadline_*` is storage-only — no negotiation enforcement yet. `MappingReminderService` does NOT read `email_enabled` so reminder rows still generate during a kill-switch window. |
| `emails` | id (BIGINT), to_user_id (FK users.id SET NULL), to_email (denormalized), subject, body (MEDIUMTEXT), body_format (`text`/`html`), status (`queued`/`sending`/`sent`/`failed`), priority, attempts, max_attempts, last_error, locked_at, locked_by, next_attempt_at, sent_at, queued_at, created_by_user_id, template_key, metadata (JSON). Indexes: `(status, next_attempt_at)`, `to_user_id`, `queued_at` | Queue for transactional email. Admin UI (`/admin/emails`) lists/filters/retries. **Append-only from admin** — no edit/delete; retry resets `status`→`queued` + clears `last_error`, **leaves `attempts` unchanged** (no infinite-loop risk). Cron worker leases rows (`locked_at`/`locked_by`), publishes via `NotificationsService.send(...)`, transitions `queued`→`sending`→`sent`/`failed` (exponential backoff). `EmailsService.enqueue(...)` is the internal-only API (no HTTP enqueue). Reminder jobs use `metadata.reminderDate` + `template_key` for daily idempotency. |

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

Per-mapping negotiation actions (center_rep, program_rep, workflow_admin unless noted):
- `POST /:id/open` — open negotiation on a draft (center_rep)
- `POST /:id/counter-propose` — body `{ proposedAllocation, justification }`. Resets agreement flags + implicitly agrees on behalf of proposer. Allowed on `negotiating` AND `agreed` (counter on `agreed` reverts to `negotiating` so counter-party re-agrees — used to unblock over-allocated rounds). Rejects `draft`/`removed`. No ratings.
- `POST /:id/agree` — empty body. Blocked when replying to your own proposal. No ratings. **Program-side agree gate**: rejects with **400 `{ code: 'TOC_LINKS_REQUIRED', statusCode: 400, message }`** unless the mapping has ≥1 AOW AND (≥1 Output OR ≥1 Intermediate Outcome) in `mapping_toc_links`. Center-side agree bypasses the gate.
- `PATCH /:id/toc-links` — program_rep + workflow_admin only. Body `{ aowIds: number[], outputIds: number[], outcomeIds: number[] }`. Atomic delete-all + reinsert; appends one `toc_updated` event; does NOT reset agreement flags. Rejects `draft`/`removed` mappings and locked projects. Cross-program ids → 400 `INVALID_TOC_IDS` with explicit `type:id` list. Outcome ids validated against `outcome_type='intermediate'` only.
- `POST /:id/remove` — remove with justification. **program_rep → 403** (use `/request-removal`). When a removal request is pending, this endpoint accepts it (program rep's reason merged into the audit event).
- `POST /:id/request-removal` — program rep only; justification ≥ 10 chars. Sets `removal_requested = true` until center resolves. **409** if already pending.
- `POST /:id/decline-removal` — center_rep/workflow_admin reject a pending removal request; optional `reason` recorded on `removal_declined` event.
- `PATCH /:id/allocation` — inline allocation edit. Resets agreement flags + appends audit event. Center-side actors MUST include `complementarityRating` + `efficiencyRating`; program-rep edits omit them. **On `draft` (post-reopen "Propose" path), center-side callers MUST include `justification` ≥ 10 chars** (persisted on the appended `COUNTER_PROPOSED` event). Non-draft paths leave `event.justification = null`.

Project-level actions (owning center_rep or workflow_admin):
- `POST /projects/:projectId/lock` — requires all non-removed mappings `agreed` AND sum = 100
- `POST /projects/:projectId/reopen` — reverts all non-removed mappings to **`draft`** (private to center) + clears agreement flags. Center then edits via `PATCH /:id/allocation` and re-launches via `startNegotiationRound` to flip drafts to `negotiating` (visible to program reps).
- `POST /projects/:projectId/chat` — free-text message (also participating program_rep)

### Reference Data (root)
- `GET /centers`, `GET /programs`, `GET /countries`, `GET /action-areas` — cached 5min (any auth)
- `GET /toc/aows?programId=N` — any auth. Returns the program's AOWs ordered by `wp_official_code`.
- `GET /toc/outputs?programId=N&aowIds=1,2` — any auth. Optional `aowIds` (CSV or repeated) filters to those AOWs.
- `GET /toc/outcomes?programId=N&aowIds=1,2` — any auth. **Intermediate outcomes only** (`outcome_type='intermediate'` hardcoded — portfolio EOIs never surfaced).

### Admin (`/admin/`)
- `POST /sync-clarisa` — trigger CLARISA sync (admin)
- `POST /sync-toc` — trigger MEL TOC sync (admin). Iterates every row in `programs`, calls `https://toc.mel.cgiar.org/api/toc/{official_code}` per program, upserts AOW + Outcome + Output rows in a transaction per program. 404 from TOC API logs a warning and increments `failed`; loop continues. Idempotent (upsert on `(program_id, node_id)`). Auto-runs on first startup if all three TOC tables are empty. Response: `{ synced, failed, details: [{ programCode, aows, outcomes, outputs, error? }] }`.
- `GET /admin/toc/aows?programId&page&limit&search` — paginated AOW list scoped to one program; `search` matches acronym/wp_official_code/name (admin)
- `GET /admin/toc/outcomes?programId&aowId&page&limit&search` — paginated outcomes; `programId` required, `aowId` optional; `search` matches title (admin)
- `GET /admin/toc/outputs?programId&aowId&page&limit&search` — paginated outputs; same shape as outcomes (admin)
- `POST /import-csv` — import TOC_Projects.csv (admin)
- `POST /reimport-csv` — re-run import (admin)
- `POST /admin/imports/bulk` — multi-file upload (admin). Auto-detects by filename + header signature: TOC, 4.1 Project Info, 4.3 Project Budget, **Signalling**. All importer rows attributed to synthetic `system@prms.cgiar.org`. Every `initiated` event carries `justification = "Baseline mapping 2025"`. **Bypasses the 3-mapping cap.**
  - **TOC**: wipes negotiation thread per touched mapping and replays a canonical `initiated` event. On existing projects, TOC is supplemental: `description`/`summary` are fill-empty (never clobber edits); `total_budget`/`remaining_budget`/`is_global`/`countries` are authoritative overwrites. Anaplan-sourced fields (`name`, `start_date`, `end_date`, `center_id`, `funding_source`, `funder`) are NEVER updated by TOC — those come from 4.1. Brand-new projects insert with full field set.
  - **Signalling** per-row outcome:
    - `Increased`/`Decreased` → `initiated` + `counter_proposed`; mapping stays `negotiating` (programAgreed=true, centerAgreed=false); project force-**unlocked**. Comment on `counter_proposed.justification`.
    - `Keep as is` → `initiated` only; `proposedAllocation = baseline`; project force-**locks** unless any row is Increased/Decreased. Spreadsheet comment discarded.
    - `Removed` → `initiated` + `removed` (comment on `removed` event). If EVERY row on a project is `Removed` (sum = 0%), project force-**unlocked** (empty round). Otherwise Removed doesn't affect lock direction.
    - Re-import wipes prior system-authored chat rows on each touched project.

### Center Mapping Imports (`/center-imports/mappings/`)
Bulk-import center-rep mappings from an Excel file (center_rep + workflow_admin). Two-phase flow with an in-memory session cache keyed by a short-lived JWT `batchId`. Bypasses the 3-mapping cap (legacy seeds), but enforces project ownership scoping against the active center.
- **Two accepted file shapes (auto-detected by `parseExcel`):**
  - **Projects-export shape** (preferred) — sheet `Projects` matching the standard list export. One row per project; up to 3 program slots per row (cols Q/U/Y + %/Complementarity/Efficiency). Empty slots skipped. Header schema check on cols 2/18/19/20/21/22/26 — mismatched header → 400. H/M/L letters normalize to high/medium/low. No Justification column → `justification = null` on the row. List sheet's "% check" column is a live `=SUM(<Program % cells>)` formula; reviewers can tweak %s in place and the total updates.
  - **Legacy template shape** — sheet `Mappings`, 7-column layout (project code, project name, program code, allocation %, complementarity, efficiency, justification). `GET /template` still emits this for back-channel use; the UI no longer surfaces a download button.
- `GET /template` — returns the legacy pre-filled template (`.xlsx`). Kept for back-compat; frontend hides the button and instructs reps to upload the projects export instead.
- `POST /validate` — multipart upload; parses + validates the file in memory, caches parsed rows under a `batchId`, returns `{ batchId, rows, errors, warnings, summary }` with row-level diagnostics. No DB writes. Justification optional everywhere (blank → null); if provided, ≥10 chars required.
- `POST /commit` — body `{ batchId }`; commits the cached batch to `project_mappings` + appends `mapping_negotiations` events attributed to the uploading user. Cache entry is consumed on success; expired/missing batchIds return 410.

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
`NotificationsModule`: producer-only integration with CGIAR Notification Microservice over RabbitMQ (`Transport.RMQ`, routing key `send`). `NotificationsService.send({ to, cc?, bcc?, subject, text?, html? })` builds `{ auth, data: { from, emailBody: { …, message: { text, socketFile } } } }` (base64-encodes `html` into `socketFile`). Two-layer kill switch: `NOTIFICATIONS_ENABLED=false` (default) disables module entirely; `NOTIFICATIONS_DRY_RUN=true` (default when enabled) builds+logs but skips emit. Broker errors swallowed + logged — outages never abort the caller.

### Settings (`/settings`)
Singleton system-wide config behind `/admin/settings`. `email_enabled` is the admin kill switch for outbound mail (dispatcher skips leasing when off); broker independently gated by `NOTIFICATIONS_ENABLED`/`NOTIFICATIONS_DRY_RUN` env flags.
- `GET /settings` — any auth user. Response: `{ emailEnabled, deadlineEnabled, deadlineDate, updatedAt, updatedBy }`. `deadlineDate` is `YYYY-MM-DD` or null.
- `PATCH /settings` — admin only. If `deadlineEnabled=true`, `deadlineDate` is required + must be strictly future (today rejects). If `false`, any submitted date force-cleared.

### Scheduled Jobs

| Job | Schedule | Module | Kill switches |
|---|---|---|---|
| Email dispatcher | `*/2 * * * *` (every 2 min) | `EmailsModule / EmailsDispatchService` | `system_settings.email_enabled`, `NOTIFICATIONS_ENABLED` |
| Center mapping reminders | `0 9 * * *` (daily 09:00 UTC) | `EmailsModule / MappingReminderService` | `system_settings.deadline_enabled`, deadline passed, center ≥ 90% (NOTE: `system_settings.email_enabled` does NOT gate generation — it gates dispatch only, so rows still enqueue when emails are paused and publish automatically once re-enabled) |

**Reminder cadence** (`MappingReminderService`): `>3 days to deadline` → weekly (Mondays UTC); `≤3 days` → daily. Template `center_mapping_reminder`. Idempotency key: `(to_user_id, template_key, metadata.reminderDate=today)`. Skips if `deadline_enabled=false`, deadline passed, center `mappedPercent ≥ 90`, `totalBudgetYear = 0`, or no active `center_rep` for center. Recipients: all active `center_rep` joined via `user_centers` (multi-center reps get one per center). Subject = center acronym; salutation = center full name.

### Email Management (`/admin/emails`)
Admin-only queue view + retry surface for the `emails` table.
- `GET /admin/emails` — paginated; filters: `status`, `toUserId`, `search` (subject + to_email), `dateFrom`/`dateTo` (on `queued_at`), `sortBy` ∈ `queued_at`/`sent_at`/`status`/`attempts`, `sortDir`. List items omit `body` and `last_error`.
- `GET /admin/emails/:id` — full row incl. `body`, `bodyFormat`, `lastError`, `lockedAt/By`, `templateKey`, `metadata`.
- `POST /admin/emails/:id/retry` — only when `status='failed'` (else 400 `EMAIL_NOT_RETRIABLE`). Resets `status`→`queued`, clears `last_error`/`locked_*`, sets `next_attempt_at=NOW()`. **Does not reset `attempts`** (no infinite-loop risk).
- `POST /admin/emails/test-send` — body `{ toUserId }`. Enqueues fixed HTML template. **Bypasses `email_enabled`** at enqueue (dispatcher still waits for toggle). Inactive users allowed; only missing email → 400. Surfaced on `/admin/settings`.
- `DELETE /admin/emails/queued` — bulk purge. Hard-DELETEs `status='queued'` rows only (`sending`/`sent`/`failed` immune). Returns `{ deleted }`. Audit log names first 50 ids + count. Surfaced as "Purge queued (N)" on `/admin/emails` toolbar.

`EmailsService.enqueue(...)` is the internal-only API for other modules to send mail. No HTTP enqueue. Current callers: `MappingReminderService`.

