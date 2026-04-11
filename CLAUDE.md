# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PRMS Projects Registry is a project management and registry tool for CGIAR's Performance and Results Management System (PRMS). It enables tracking, managing, and reporting on research projects across the CGIAR portfolio.

**Core workflow**: Admin creates projects → Program Reps map projects to their program with % allocation (must total 100%) → Center Reps approve/reject mappings.

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
- Refresh token in httpOnly cookie (path: `/api/auth`, 30-day expiry)
- On page refresh: Angular calls `POST /api/auth/refresh` → gets new access token → calls `GET /api/auth/me`
- `AuthService.initialized` promise must be awaited by guards before checking auth state

### Dev Login (Browser Testing with Playwright)
To test the app via Playwright MCP (bypasses Cognito, dev-only):

1. **Start test server** (HTTP, no SSL issues): `npx ng serve --configuration test` (port 4202)
2. **Navigate to**: `http://localhost:4202/auth?dev=admin@codeobia.com`
3. This calls `GET /api/auth/dev-token?email=...` which returns a JWT + sets a refresh cookie
4. The app redirects to `/dashboard` authenticated as that user
5. **CORS**: Make sure `CORS_ORIGIN` in `.env` includes `http://localhost:4202`
6. **In-app navigation works** — click nav links (don't do full page `goto` to other routes, as the token is in-memory and will be lost)
7. For full-page navigation, re-auth first: `page.goto('http://localhost:4202/auth?dev=admin@codeobia.com')`

**Endpoints (dev-only, NODE_ENV=development):**
- `POST /api/auth/dev-login` — body `{ email }`, returns `{ accessToken, user }` + sets refresh cookie
- `GET /api/auth/dev-token?email=...` — same but GET (used by Angular `devLogin()`)

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
- Admin can trigger manual sync via `POST /api/admin/sync-clarisa`
- 5-minute in-memory cache on reference data endpoints

## Roles & Permissions

| Role | Can Do |
|------|--------|
| **Admin** | CRUD projects, manage users (assign roles), trigger CSV import, trigger CLARISA sync, view all data |
| **Program Rep** | Map projects to their program (% allocation), edit/delete own pending mappings, view projects |
| **Center Rep** | Approve/reject mappings for projects in their center (only when allocation = 100%), view projects |

- Roles stored in `users.role` column (nullable — new users have no role until admin assigns one)
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

5 migrations in `api/src/database/migrations/`:

| Table | Key Columns | Relations |
|-------|-------------|-----------|
| `users` | id, cognito_sub, email, first_name, last_name, role (enum), is_active | FK → programs, FK → centers |
| `centers` | id, clarisa_id, code, name, acronym, institution_id, synced_at | Synced from CLARISA |
| `programs` | id, clarisa_id, official_code, name, synced_at | Synced from CLARISA |
| `countries` | id, clarisa_id, iso_alpha_2, iso_alpha_3, name, region, synced_at | Synced from CLARISA |
| `action_areas` | id, clarisa_id, name, description, color, synced_at | Synced from CLARISA |
| `projects` | id, code (unique), name, description, summary, results, start_date, end_date, total_budget, remaining_budget, funding_source (enum), funder, status (enum) | FK → centers, FK → users (created_by), M2M → countries |
| `project_countries` | project_id, country_id | Join table |
| `project_mappings` | id, project_id, program_id, allocation_percentage, complementarity_rating, efficiency_rating, status (enum), rejection_reason, submitted_at, reviewed_at | FK → projects, FK → programs, FK → users (submitted_by, reviewed_by). UNIQUE(project_id, program_id) |

**Critical business rule**: `SUM(allocation_percentage) WHERE project_id = X AND status != 'rejected'` must equal 100 before center reps can review. Enforced at application layer with pessimistic locking.

## API Endpoints

### Auth (`/api/auth/`)
- `GET /login` — returns Cognito authorization URL (public)
- `POST /callback` — exchanges code for tokens (public)
- `POST /refresh` — refreshes access token via cookie (public)
- `POST /logout` — revokes token, clears cookie (public)
- `GET /me` — returns current user (JWT required)

### Projects (`/api/projects/`)
- `GET /` — paginated list with search/filters (any auth)
- `GET /:id` — single project with relations (any auth)
- `POST /` — create project (admin)
- `PATCH /:id` — update project (admin)
- `DELETE /:id` — archive project (admin)

### Mappings (`/api/mappings/`)
- `GET /` — role-filtered list (any auth)
- `GET /:id` — single mapping (any auth)
- `POST /` — create mapping (program_rep)
- `PATCH /:id` — update own pending mapping (program_rep)
- `DELETE /:id` — delete own pending mapping (program_rep)
- `POST /:id/approve` — approve mapping (center_rep, requires 100% allocation)
- `POST /:id/reject` — reject mapping with reason (center_rep)
- `GET /projects/:projectId/allocation` — allocation summary (any auth)
- `GET /projects/:projectId/review-summary` — review details (admin, center_rep)

### Reference Data (`/api/`)
- `GET /centers`, `GET /programs`, `GET /countries`, `GET /action-areas` — cached 5min (any auth)

### Admin (`/api/admin/`)
- `POST /sync-clarisa` — trigger CLARISA sync (admin)
- `POST /import-csv` — import TOC_Projects.csv (admin)

### Users (`/api/users/`)
- `GET /` — list all users (admin)
- `PATCH /:id` — update role/program/center/active (admin)

### Dashboard (`/api/dashboard/`)
- `GET /summary` — role-aware aggregate stats (any auth)
- `GET /allocation-status` — projects by allocation % (any auth)
- `GET /recent-activity` — latest mapping events (any auth)

## Build Progress

**Waves 1-8: COMPLETE** — Full implementation across 36 tasks:
- Wave 1: Foundation & Auth (Cognito OAuth2, JWT, guards, Angular shell)
- Wave 2: CLARISA Sync (reference data entities, sync service)
- Wave 3: Project CRUD (entity, service, controller, Angular pages)
- Wave 4: Program Mapping (allocation validation, pessimistic locking)
- Wave 5: Center Approval (approve/reject workflow, resubmission)
- Wave 6: CSV Import (283 projects imported from TOC_Projects.csv)
- Wave 7: Dashboard & Users (role-aware stats, charts, user management)
- Wave 8: QA & Polish (security hardening, error handling, accessibility, prod Docker)
