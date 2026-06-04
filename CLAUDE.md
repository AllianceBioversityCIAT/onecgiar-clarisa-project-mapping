# CLAUDE.md

Guidance for Claude Code working in this repo. **Update this file only when a change adds a non-obvious rule, invariant, or gotcha that a fresh agent couldn't recover by reading the code.** Skip updates for new endpoints, new columns, new components, renames, or routine feature work — controllers, entities, and migrations are authoritative for those.

## Project Overview

PRMS Projects Registry — project management + registry tool for CGIAR's Performance and Results Management System.

**Core workflow:** Admin creates projects → Center Rep initiates mappings to programs with % allocation → Center and Program Reps negotiate via chat/counter-propose → when all mappings are agreed and total = 100%, Center Rep locks the round. Project-level `negotiation_locked` flag is the single source of truth.

## Repository Structure

```
api/    NestJS backend — src/{common,config,database/migrations,modules/{auth,users,projects,mappings,reference-data,clarisa,import,dashboard,...}}, test/, .env.example
web/    Angular 21 + PrimeNG v21 — src/app/{core,features (lazy),shared,layout}
docker-compose.yml (dev), docker-compose.prod.yml, nginx/, logs/, media/, CLAUDE.md
```

Standard `npm` scripts in `api/` and `web/`. `docker-compose up --build` from root brings up API:3000, Web:4200, MySQL:3306, phpMyAdmin:8080.

## Deployment

| Remote | Repo | Deploy branch | Env |
|---|---|---|---|
| `origin` | `CodeObia/PRMS-Projects-Registry` | `development` | Dev (CodeObia) |
| `ciat` | `AllianceBioversityCIAT/onecgiar-clarisa-project-mapping` | `main` | Prod (CIAT) |

Local work on `master`. Deploys via PR + **merge commit** (never squash/rebase — preserve history on both deploy branches).

- `/push-to-development` — `master` → `origin/development` (PR + merge). Never touches CIAT.
- `/push-to-production` — `master` → `origin` AND `ciat`; opens `ciat master→main` PR; merges.

**Default push target is `origin`** — never push to `ciat` manually; always go through `/push-to-production` for the audit trail.

## Tech Stack

NestJS + Angular 21 + PrimeNG 21 + MySQL 8 + TypeORM (migrations only, `synchronize: false`). Node 22 LTS (`.nvmrc`). Auth via AWS Cognito OAuth2 + local JWT. External APIs: CLARISA (Centers, Programs, Countries, Action Areas), MEL TOC (AOWs, Outcomes, Outputs). Logging via Winston + winston-daily-rotate-file.

### Framework gotchas (the non-obvious stuff)

- **Angular 21:** `"polyfills": ["zone.js"]` required in `angular.json` build options. Serve options need `"ssl": true` + `"allowedHosts": ["localhost"]`.
- **PrimeNG v21 renames:** `Select` (not Dropdown), `DatePicker` (not Calendar), `Textarea` from `primeng/textarea` (not `InputTextareaModule`). Templates: `p-select`/`p-datepicker`. `optionLabel` (not `[field]`) on AutoComplete.
- **PrimeNG overlay clipping — three places to set `appendTo="body"`:**
  1. `app.config.ts` sets `providePrimeNG({ overlayOptions: { appendTo: 'body' } })` — covers Select/MultiSelect/AutoComplete/CascadeSelect/TreeSelect/ColorPicker/Password.
  2. `p-datepicker` does NOT consume global options — pass `appendTo="body"` on every instance.
  3. `p-table` paginator dropdown is separate — pass `paginatorDropdownAppendTo="body"` on every paginated table.
- **TypeORM QueryBuilder + `getManyAndCount()` + `leftJoinAndSelect`:** use **raw DB column names** in `orderBy` (`project.created_at`) and `offset/limit` instead of `skip/take` to avoid the `databaseName` undefined bug.
- **TypeORM QueryBuilder `.where()`/`.andWhere()`:** use **camelCase** property names (`project.centerId`), NOT snake_case.
- **Monetary values:** `decimal(10,2)` in DB, never `float`.
- **No API global prefix.** Routes mount at root (`/auth/...`, `/projects/...`). `main.ts` does NOT call `setGlobalPrefix`. The web container's nginx proxies `/api/*` → api with the `/api` prefix stripped.
- **CORS:** `CORS_ORIGIN` accepts comma-separated origins.
- **Angular assets:** `web/public/` (served at root) or `web/src/assets/` (served at `/assets/`). Both configured in `angular.json`.

## Authentication & Active Center

- Cognito handles login only (OAuth2 authorization code flow). **Roles assigned internally** via Users page, NOT from Cognito claims.
- Backend verifies ID token via JWKS (issuer extracted dynamically from token's `iss`), upserts user, issues local JWT (access 15min memory-only + httpOnly refresh cookie 30d, path `/`).
- On page refresh: Angular calls `POST /auth/refresh` → `GET /auth/me`. **`AuthService.initialized` promise must be awaited by guards** before checking auth state.
- **JWT carries `centerIds: number[]`** — ordered list for a `center_rep` (primary first, `user_centers.sort_order` ASC). Empty for non-center-rep roles. `users.center_id` = primary = `centerIds[0]`.
- **Active-center overlay:** multi-center reps switch via header `CenterSwitcherComponent`. Auth interceptor attaches `X-Active-Center: <id>` to API requests (except `/auth/*`) when `centerIds.length > 1`. Backend `ActiveCenterInterceptor` validates against `req.user.centerIds` and overlays `req.user.centerId`. Forged ids → **403 `{ code: 'ACTIVE_CENTER_INVALID' }`**.
- **Frontend graceful recovery:** on `ACTIVE_CENTER_INVALID`, error interceptor refreshes `/auth/me`, calls `AuthService.resetActiveCenterToFirst()`, toasts, retries once (loop guard via `HttpContextToken`). `activeCenterId` persisted to `localStorage.prms.activeCenterId`.
- **Staleness window:** ≤15min after admin reassigns centers (JWT still carries old `centerIds` until next refresh); stale header triggers recovery flow above.

### Dev Login (Browser Testing)

Bypasses Cognito (dev-only, `NODE_ENV=development`). See the `dev-login` skill. Endpoints: `POST /auth/dev-login` (`{ email }`), `GET /auth/dev-token?email=...`.

**Playwright artifacts (MANDATORY)** — all screenshots, snapshots, traces go in `playwright/` at repo root (gitignored). Always pass `filename: playwright/<name>.png` to `browser_take_screenshot`. Applies to all subagents.

## Roles & Permissions

Role enum on `users.role` (nullable). `@Roles(UserRole.X)` decorator + global `RolesGuard`. `@Public()` bypasses JWT.

| Role | Capability summary |
|---|---|
| **Admin** | CRUD projects, manage users, CSV import, CLARISA sync. **Read-only on negotiation surface** (`workflow_admin` is the arbiter). **Cannot edit Anaplan-sourced fields** (`code`, `centerId`, `startDate`, `endDate`, `fundingSource`, `funder`, 2026 Anaplan block) — only CSV import overwrites them. |
| **Program Rep** | Negotiation on mappings to their program: agree, counter-propose, chat, **request removal** (cannot remove unilaterally). Cannot create mappings or lock rounds. **Does not set complementarity/efficiency ratings.** |
| **Center Rep** | Initiate mappings for projects in their center; open/counter-propose/agree/remove during negotiation; accept/decline program-rep removal requests; lock/reopen rounds. **Sets complementarity + efficiency ratings** on create and every center-side allocation edit. Edits non-Anaplan metadata via `PATCH /projects/:id/metadata`. Exclude/unexclude projects in own center. Multi-center: switches via header; active center scopes every request. |
| **Workflow Admin** | System-office arbiter: full negotiation rights on every project regardless of center. Lands on `/needs-assistance` (auto-flagged after a program rep's 2nd counter-proposal). Cannot manage projects/users/data ops. |
| **Unit Admin** (PPU/PCU) | Edit whitelisted project metadata on **any** project regardless of `negotiation_locked`. Trigger published-snapshot republishes. View project audit history. |
| **No role** (null) | Read-only viewer. `GET /projects` + `GET /projects/:id` only; mutating endpoints return **403**. |

## Agent Workflow

**All user instructions must flow through `tech-project-manager` first.** PM analyzes, clarifies, breaks into actionable tasks, dispatches to specialists.

| Agent | For |
|---|---|
| `tech-project-manager` | Planning, specs, ambiguous requirements, multi-agent coordination |
| `angular-frontend-expert` | Frontend components, UI/UX, Angular routing, forms, styling |
| `nestjs-backend-expert` | API endpoints, DB schema, services, integrations, backend logic |
| `devops-docker-jenkins` | Dockerfiles, pipelines, docker-compose, deployment configs |
| `ui-tester` | Post-implementation UI verification (NOTE: user prefers running UI tests manually — skip unless asked) |
| `qa-test-engineer` | API validation, e2e tests, backend QA |
| `typeorm-migration-reviewer` | **Mandatory** for any new/modified `api/src/database/migrations/` file |

Prefer the MySQL MCP for DB inspection (`mysql_query` — read-only, points at docker-compose MySQL) instead of asking the user.

## Project Rules

1. **Clean code + comments** — explain non-trivial logic; single-responsibility throughout.
2. **Minimal dependencies** — prefer lightweight custom code over npm packages for small utilities. Only well-maintained, framework-compatible deps.
3. **PrimeNG only** — no Angular Material or competing UI libs. Customize via theming tokens.
4. **Winston logging** — never `console.log` in backend; use NestJS `Logger`. Files in `api/logs/` (gitignored). Every request gets a UUID via `X-Request-ID` + AsyncLocalStorage. Dev = pretty; prod = JSON. Daily rotation, 30d retention, 20MB/file.
5. **TypeORM migrations only** — `synchronize: false` enforced; never modify schema manually.
6. **`@nestjs/config` + typed configs** — never hardcode secrets; `.env` is gitignored, `.env.example` is the template.

## Critical Invariants (Non-derivable from code)

Rules a fresh agent could break without realizing — enforced in code but not obvious from any single file.

### Negotiation surface

**Append-only invariant on `mapping_negotiations`:** no service method may UPDATE this table. Every state change appends new event row(s). Change the design before mutating.

**Lock gate (manual):** `POST /mappings/projects/:projectId/lock` requires ≥1 active mapping, every non-removed mapping in `agreed` status, AND `SUM(allocation_percentage)` of non-removed mappings ≤ 100 (under-100% is allowed — the unallocated portion is intentional). Enforced with pessimistic locking on the project row. Once locked, all negotiation actions are rejected at the service layer until `reopen`.

**Auto-lock on full agreement:** `agree()` auto-locks the project round (no manual lock step) when the agree event flips the LAST active mapping to `agreed` AND `SUM(allocation_percentage)` of non-removed mappings = **exactly 100** (`tryAutoLockOnFullAgreement`, same transaction + pessimistic project lock). Stricter than the manual gate: a fully-agreed but under-100% round is NOT auto-locked — it stays open for manual lock so the center can rebalance. Auto-lock appends the same per-mapping `LOCKED` events and emits the same `project.locked` socket + audit event as the manual path, attributed to whoever cast the final agree (no RBAC check — it's a system consequence of mutual agreement). The manual lock endpoint is retained as the fallback for under-100% rounds.

**Negotiation-start 100% gate:** a round can only go live when the project is fully allocated. Both `openNegotiation` (single draft → negotiating) and `startNegotiationRound` (bulk drafts → negotiating) require `SUM(allocation_percentage)` of **all non-removed mappings = exactly 100** (`assertProjectFullyAllocated`, ±0.01). Under- or over-allocated rounds are rejected with 400 until the center rebalances. (Drafts stay private to the center until promoted, so this is the center's pre-launch balance check.)

**Rebalance-and-agree (atomic):** `POST /mappings/projects/:projectId/rebalance-and-agree` (center side only) is the one-shot path when a center-side agree would leave the project off 100%. In a single pessimistic-locked transaction it counter-proposes the listed **other `negotiating` mappings** (each new %, justification ≥10 — appends `COUNTER_PROPOSED`, sets `centerAgreed=true`/`programAgreed=false` so that program must re-accept) AND agrees the target (`AGREED`), then auto-locks if the round is now fully agreed. Gate: projected sum (rebalanced %s applied, target unchanged) over all non-removed mappings = **exactly 100**, and every rebalance target must be a distinct `negotiating` mapping (never the agree target, never agreed/draft/removed). Frontend (`consolidated-chat-pane`) routes a center agree here automatically when the plain agree wouldn't reach 100%; if there are no other `negotiating` mappings to adjust, the dialog blocks with "adjust the mappings first" (the center can't agree into an over/under-allocated round).

**Mapping cap:** a project can have at most **3 active (non-removed) mappings**. Enforced in `MappingsService.create()` and `addProgramToProject()` via `assertMappingCapNotExceeded()`. Removed mappings don't count (swap-in/out allowed). **CSV/Signalling imports intentionally bypass the cap** so legacy portfolios load.

**Program-side agree gate (TOC contribution):** `POST /:id/agree` from a program rep rejects with **400 `{ code: 'TOC_LINKS_REQUIRED', statusCode: 400, message }`** unless the mapping has ≥1 AOW AND (≥1 Output OR ≥1 Intermediate Outcome) in `mapping_toc_links`. Center-side agree bypasses the gate. **Grandfathered:** pre-existing `agreed` mappings without links stay agreed; gate fires only on new `agree()` calls.

**TOC outcome filter:** `GET /toc/outcomes` and the agree gate count only `outcome_type='intermediate'` (portfolio EOIs never surfaced or accepted).

**Ratings rule:** complementarity + efficiency ratings are **center-side only** (required on create + center-side allocation edits). Program-rep paths must omit them.

**Removal flow:** program reps cannot remove unilaterally. `POST /:id/remove` from a program rep → 403. They call `/request-removal` (justification ≥10 chars); center resolves via `/remove` (accepts, merges reason into audit event) or `/decline-removal`.

**Reopen path:** `reopen` reverts non-removed mappings to **`draft`** (private to center) + clears agreement flags. Center edits via `PATCH /:id/allocation` then re-launches via `startNegotiationRound` to flip drafts → `negotiating` (visible to program reps). On `draft` post-reopen, center-side `PATCH /:id/allocation` MUST include `justification` ≥10 chars (persisted on appended `COUNTER_PROPOSED` event).

### Negotiation Test Gate (Mandatory)

Three-tier suite pins the append-only invariant and every role/state rule. Any change to the negotiation surface MUST run these and keep them updated.

**Surface:** `api/src/modules/mappings/**`, migrations touching `mapping_negotiations.event_type`, `web/src/app/features/mappings/project-negotiation-consolidated/**`, `mapping-form/**`, any role/permission/business rule affecting negotiation.

```bash
cd api && npx jest src/modules/mappings/mappings.service.spec.ts                    # Unit
cd api && npx jest --config test/jest-e2e.json test/negotiation.e2e-spec.ts          # E2E (real MySQL)
cd tests/browser && PRMS_API_URL=http://localhost:3000 npx playwright test           # Browser
```

Update specs when adding/changing rules. New event types → unit + e2e. New endpoint/DTO field → unit + e2e + browser (if UI). **Never delete or weaken a test to make it pass.**

### Imports

**TOC import is supplemental on existing projects:** `description`/`summary` are fill-empty (never clobber edits); `total_budget`/`remaining_budget`/`is_global`/`countries` are authoritative overwrites. **Anaplan fields (`name`, `start_date`, `end_date`, `center_id`, `funding_source`, `funder`) are NEVER updated by TOC** — those come from 4.1. Brand-new projects insert with full field set.

**Signalling import per-row outcome:**
- `Increased`/`Decreased` → `initiated` + `counter_proposed`; mapping stays `negotiating`.
- `Keep as is` → `initiated` only at baseline.
- `Removed` → `initiated` + `removed`.

**Project lock rule (per project):** LOCKED only when **every** row on the project is `Keep as is`. Any `Increased`, `Decreased`, or `Removed` row on a project force-**unlocks** it so the center can resolve / rebalance to 100% in PRMS.

All importer rows attributed to `system@prms.cgiar.org`. Re-import wipes prior system-authored chat rows on each touched project.

**Center-rep import 100% gate (skip, not block):** the center-rep `center-imports` validate flow (`POST /center-imports/mappings/validate`) requires each project's rows to sum to **exactly 100%**. A project that doesn't reach 100% (over OR under) is **skipped** — added to the response's `skipped[]` (project-level), excluded from `committableRows` (never created/updated, and its existing mappings are NOT flagged for removal), while the rest of the batch still gets a `batchId` and commits. Distinct from the legacy hard-error path: `errors[]` blocks the whole batch; `skipped[]` excludes only the offending project. Unlike the system Signalling/TOC imports, this center-rep importer does NOT bypass the mapping cap or the 100% rule.

### Multi-center user model

`user_centers` is a M2M junction with **ordered membership**: `sort_order` INT (0 = primary). `users.center_id` mirrors `centerIds[0]`. **`UsersService.replaceUserCenters()` uses raw `manager.query()` INSERT** because TypeORM QueryBuilder collapses `sort_order` to 0 on entity-less junctions. PATCH does atomic delete-all + reinsert preserving submission order. Service deduplicates incoming `centerIds`. Deactivating a user does NOT delete `user_centers` rows — reactivating restores memberships.

### Email kill switches (two layers)

1. **`system_settings.email_enabled`** — admin kill switch. When `false`, `EmailsDispatchService` skips leasing every tick (queued rows pile up; auto-publish once re-enabled). `POST /admin/emails/test-send` bypasses the gate at enqueue but dispatcher still waits. **`MappingReminderService` does NOT read this** — reminders still generate during a kill-switch window.
2. **`NOTIFICATIONS_ENABLED` / `NOTIFICATIONS_DRY_RUN` env flags** — broker-level. Default off / dry-run. Broker errors swallowed + logged; outages never abort the caller.

`emails` retry resets `status`→`queued` + clears `last_error`, **leaves `attempts` unchanged** (no infinite-loop risk).

### Audit & published snapshots

`project_audit_events` is append-only. **Decimal fields stay as strings in JSON** to avoid IEEE 754 precision loss. One row per changed field. `published_snapshots.created_by_role` records whether the publish came from admin or unit_admin.

### Project exclusions

Per-(project, center) hide-from-default-view. Center-rep-scoped queries filter out excluded projects unless `showExcluded=true`. Admin/center-rep can exclude/unexclude; `reason` required (≥5 chars). Writes `project.excluded`/`project.unexcluded` audit events.

## PRMS Brand & Theme

Theme matches https://risk.cgiar.org exactly (same CGIAR PRMS tool family). Header is dark navy with pill-shaped nav links; content area uses `#5569dd` accent. **Copy styles directly from `../risk` codebase, don't approximate.** Theme tokens live in the actual SCSS — read those, don't mirror them here.
