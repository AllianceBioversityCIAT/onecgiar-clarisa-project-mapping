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
- **PrimeNG v21 naming changes**: `Select` (not Dropdown), `DatePicker` (not Calendar), `p-select`/`p-datepicker` in templates, `optionLabel` (not `[field]`) on AutoComplete
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
| **Admin** | CRUD projects, manage users (assign roles), trigger CSV import, trigger CLARISA sync, view all data, act on any mapping/project. Can exclude/unexclude any project (exclusion recorded under project's owning center; admin can target a specific exclusion row via `?centerId=` on unexclude). Admin's default list is unfiltered; passing `?showExcluded=true` filters to projects excluded by any center. **Cannot edit Anaplan-sourced fields via the update endpoint** — `code`, `centerId`, `startDate`, `endDate`, `fundingSource`, `funder`, and the 2026 Anaplan metadata block are immutable for every role (only the CSV import overwrites them). |
| **Program Rep** | Participate in negotiation on mappings to their program: agree, counter-propose allocation, post chat messages, **request removal** (asks the center side; cannot remove unilaterally). Cannot create mappings or lock rounds. **Does not set complementarity / efficiency ratings** — those are a center-side responsibility. |
| **Center Rep** | Initiate mappings for projects in their center, open/counter-propose/agree/remove during negotiation, **accept or decline a program rep's removal request** from the chat thread, post chat messages, **lock** and **reopen** the project round (only when all mappings are agreed and total = 100%). **Sets complementarity and efficiency ratings** on create and on every center-side allocation edit. Can **exclude/unexclude projects in their own center** — excluded projects are hidden from their default list, dashboard aggregates, and mapping list until restored or `showExcluded=true` is passed. |
| **Workflow Admin** | System-office arbiter: full negotiation rights on every project (counter-propose, agree, remove, accept/decline removal request, add-program, lock, reopen, chat) regardless of center. Lands on `/needs-assistance` queue (mappings auto-flagged after a program rep's 2nd counter-proposal). Cannot manage projects, users, or run admin-only data ops (CSV import, CLARISA sync). |
| **Unit Admin** (PPU/PCU) | Edit a whitelisted set of project metadata fields (`name`, `description`, `summary`, `results`, `totalBudget`, `remainingBudget`) on **any** project regardless of `negotiation_locked` state. Required `justification` ≥ 5 chars on every edit. Trigger published-snapshot republishes. View project audit history. Cannot edit Anaplan-sourced fields (code, center, startDate, endDate, fundingSource, funder, countries, and the 2026 Anaplan metadata block). Cannot manage users, mappings, or negotiation. |
| **No role** (null) | Read-only viewer. Can browse `GET /projects` and `GET /projects/:id` (no `@Roles` decorator on those endpoints). All mutating endpoints (`POST` / `PATCH` / `DELETE` on projects, mappings, exclusions, etc.) return **403** via `RolesGuard`. Frontend lands on `/projects` (the `dashboardAccessGuard` redirects them off `/dashboard`). The header nav only shows Home / Projects. The project list shows the cross-center Center column + filter; the "Suggested to reach 90%" tile, "What-if Selection" tile, row checkboxes, and "Use suggested set" button are hidden (planning UI is admin / center_rep only). `GET /dashboard/*` is gated controller-wide with `@Roles(ADMIN, PROGRAM_REP, CENTER_REP)`. |

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
| `users` | id, cognito_sub, email, first_name, last_name, role (enum), is_active | FK → programs, FK → centers |
| `centers` | id, clarisa_id, code, name, acronym, institution_id, synced_at | Synced from CLARISA |
| `programs` | id, clarisa_id, official_code, name, synced_at | Synced from CLARISA |
| `countries` | id, clarisa_id, iso_alpha_2, iso_alpha_3, name, region, synced_at | Synced from CLARISA |
| `action_areas` | id, clarisa_id, name, description, color, synced_at | Synced from CLARISA |
| `projects` | id, code (unique), name, description, summary, results, start_date, end_date, total_budget, remaining_budget, funding_source (enum), funder, status (enum), **negotiation_locked** (bool) | FK → centers, FK → users (created_by), M2M → countries |
| `project_countries` | project_id, country_id | Join table |
| `project_mappings` | id, project_id, program_id, allocation_percentage, status (enum: `draft` / `negotiating` / `agreed` / `removed`), center_agreed (bool), program_agreed (bool), initiated_by, initiated_at, `complementarity_rating` (enum: `high`/`medium`/`low`, nullable), `efficiency_rating` (enum: `high`/`medium`/`low`, nullable), `removal_requested` (bool), `removal_requested_by` (FK users, nullable), `removal_requested_at` (datetime, nullable), `removal_justification` (text, nullable). `rejection_reason`, `submitted_by/at`, `reviewed_by/at` are retained as **deprecated/legacy** columns. **Ratings are a center-side responsibility**: required at create (`POST /mappings`, `POST /mappings/projects/:projectId/add-program`) and on every center-side allocation edit (`PATCH /mappings/:id/allocation` when actor is admin / center_rep / workflow_admin). Program-rep allocation edits, counter-proposals, and agree calls do NOT touch ratings — those endpoints carry no rating fields. Legacy rows with null ratings remain null until the next center edit, which is required to fill them. **Program reps cannot remove unilaterally** — they raise a request via `removal_*` columns; center side accepts (regular `/remove`) or declines (`/decline-removal`). | FK → projects, FK → programs, FK → users (initiated_by, removal_requested_by). UNIQUE(project_id, program_id) |
| `mapping_negotiations` | id, project_mapping_id, event_type (`initiated` / `counter_proposed` / `agreed` / `reopened` / `removed` / `flagged_for_assistance` / `negotiation_started` / `removal_requested` / `removal_declined`), actor_user_id, allocation_snapshot, justification, created_at | Audit trail for per-mapping negotiation events. The consolidated chat thread loads events for **all** project mappings (including removed ones) so history is preserved when a program is removed. |
| `project_negotiation_messages` | id, project_id, author_user_id, message, created_at | Free-text chat thread on the consolidated negotiation page |
| `project_audit_events` | id, project_id, actor_user_id, actor_role (enum), event_type (`field_edited` / `snapshot_republished`), field_name, value_before (JSON), value_after (JSON), justification, created_at | Append-only audit log for project metadata edits. One row per changed field (decimal fields stay as strings to avoid IEEE 754 precision loss in JSON). FK → projects (CASCADE), FK → users (RESTRICT). |
| `published_snapshots` | id, version_label, description, published_at, published_by, **created_by_role** (enum: admin / unit_admin), project_count, total_budget, summary_stats (JSON), is_active | Frozen snapshot of the active portfolio |
| `project_exclusions` | id, project_id, center_id, excluded_by_user_id, reason (text NOT NULL), excluded_at (datetime NOT NULL), created_at, updated_at. UNIQUE(project_id, center_id) | Per-center project exclusion. A center rep (or admin) can hide a project from their center's default view without touching the project entity. FK → projects (CASCADE), FK → centers (CASCADE), FK → users/excluded_by (RESTRICT). Exclusions are applied by `ProjectExclusionService`; filtered out of center-rep-scoped queries in projects, dashboard, and mappings by default unless `showExcluded=true` is passed. Audit events written on exclude (`project.excluded`) and unexclude (`project.unexcluded`). |

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
- `PATCH /:id/metadata` — constrained metadata edit (admin, unit_admin) — accepts only the unit-admin whitelist + required `justification` ≥ 5 chars; allowed even when `negotiation_locked = true`
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
- `POST /projects/:projectId/add-program` — add program from the consolidated page (admin, center_rep). Body must include both ratings (center-set, required)

Per-mapping negotiation actions:
- `POST /:id/open` — open negotiation on a draft (center_rep)
- `POST /:id/counter-propose` — submit a counter-proposal (admin, center_rep, program_rep) — resets both agreement flags and implicitly agrees on behalf of the proposer. Body is `{ proposedAllocation, justification }` — ratings are NOT collected here
- `POST /:id/agree` — mark agreement on current terms (admin, center_rep, program_rep) — blocked on replying to your own proposal. Body is empty — ratings are NOT collected here
- `POST /:id/remove` — remove a program from negotiations with justification (admin, center_rep, workflow_admin, program_rep). For program_rep this is **403** — they must use `/request-removal`. When a request is pending, the center calling this endpoint accepts it (the program rep's reason is merged into the audit event)
- `POST /:id/request-removal` — program rep raises a removal request (justification ≥ 10 chars). Mapping stays in current state with `removal_requested = true` until the center side resolves it. **409** if a request is already pending
- `POST /:id/decline-removal` — center side rejects a pending removal request (admin, center_rep, workflow_admin); optional `reason` is recorded on a `removal_declined` event so the program rep sees why
- `PATCH /:id/allocation` — inline allocation edit on the consolidated page (admin, center_rep, program_rep) — resets agreement flags + appends audit event. Center-side actors (admin / center_rep / workflow_admin) MUST include both `complementarityRating` and `efficiencyRating`; program-rep edits omit them

Project-level actions:
- `POST /projects/:projectId/lock` — lock the round (admin or owning center_rep); requires all non-removed mappings `agreed` and sum = 100
- `POST /projects/:projectId/reopen` — reopen the round (admin or owning center_rep); reverts agreed mappings to `negotiating`
- `POST /projects/:projectId/chat` — post a free-text chat message on the project negotiation thread (admin, owning center_rep, or participating program_rep)

### Reference Data (root)
- `GET /centers`, `GET /programs`, `GET /countries`, `GET /action-areas` — cached 5min (any auth)

### Admin (`/admin/`)
- `POST /sync-clarisa` — trigger CLARISA sync (admin)
- `POST /import-csv` — import TOC_Projects.csv (admin)
- `POST /reimport-csv` — re-run import (admin)
- `POST /admin/imports/bulk` — multi-file upload (admin). Auto-detects file type by filename + header signature: TOC, 4.1 Project Info, 4.3 Project Budget, **Signalling**. Signalling import semantics: per row, `Increased`/`Decreased` writes `initiated` + `counter_proposed` events (no auto-AGREED) modeled as a program-rep counter-proposal — the mapping is left `negotiating` with `programAgreed=true` / `centerAgreed=false` so only the center side still needs to agree, and the project is force-**unlocked**. `Keep as is` writes `initiated` only and force-**locks** the project (per project: locked unless any row on it is Increased/Decreased). `Removed` writes `initiated` + `removed` and does not affect lock direction. Comments: Increased/Decreased comments go on the `counter_proposed` event's `justification`; `Removed` comments on the `removed` event; `Keep as is` comments (with non-empty text) post one `project_negotiation_messages` row per row formatted `[Signalling Import — <programOfficialCode>] <comment>`, bypassing `postChatMessage()`'s lock guard. Re-import wipes prior system-authored chat rows on each touched project. All writes attributed to the synthetic `system@prms.cgiar.org` user.

### Users (`/users/`)
- `GET /` — list all users (admin)
- `POST /` — create user (admin)
- `PATCH /:id` — update role/program/center/active (admin)
- `DELETE /:id` — deactivate user (admin)

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

## Build Progress

**Waves 1-8: COMPLETE** — Full implementation across 36 tasks:
- Wave 1: Foundation & Auth (Cognito OAuth2, JWT, guards, Angular shell)
- Wave 2: CLARISA Sync (reference data entities, sync service)
- Wave 3: Project CRUD (entity, service, controller, Angular pages)
- Wave 4: Program Mapping (allocation validation, pessimistic locking)
- Wave 5: Center Approval (original approve/reject workflow — later replaced by the negotiation model)
- Wave 6: CSV Import (283 projects imported from TOC_Projects.csv)
- Wave 7: Dashboard & Users (role-aware stats, charts, user management)
- Wave 8: QA & Polish (security hardening, error handling, accessibility, prod Docker)

**Post-Wave 8 changes (April 2026):**
- Removed the API global `/api` prefix; nginx in the web container now strips `/api` before proxying.
- Redesigned the mapping workflow from approve/reject into a full negotiation: center initiates, programs and center negotiate via agree / counter-propose / remove / chat, with a consolidated two-pane UI and project-level `negotiation_locked` as the sole lock.
- Added `project_negotiation_messages` (chat) and expanded `mapping_negotiations` events; retired the mapping-level `locked` status in favor of project-level locking.
- Added `workflow_admin` role (system-office arbiter) with auto-flagged Needs Assistance queue.
- Added `unit_admin` role (PPU/PCU) with constrained `PATCH /projects/:id/metadata` endpoint, append-only `project_audit_events` table, and snapshot republish access. Whitelist of editable fields plus required justification ≥ 5 chars enforced at DTO + service layers; locked projects remain editable for unit admins.
- Added **Project Exclusion** feature (May 2026): center_rep (and admin) can exclude projects from their center's default view. New `project_exclusions` table (UNIQUE per project+center); `POST /projects/:id/exclude` + `POST /projects/:id/unexclude` endpoints; `GET /projects` center-rep filtering with `showExcluded` toggle; exclusion filtering applied to dashboard summary, allocation status, recent activity, center allocation widget, and mappings list. Frontend: "Show excluded" filter chip, "Excluded" badge + tooltip, exclude dialog with reason textarea, unexclude action, detail page banner. Bug fixed during QA: center_rep center-scoping check must compare `project.centerId !== actor.centerId` (not `centerId !== actor.centerId` after `resolveExclusionCenter`). PrimeNG v21 uses `Textarea` from `primeng/textarea` (not `InputTextareaModule`).
