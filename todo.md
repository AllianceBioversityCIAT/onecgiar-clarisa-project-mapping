# PRMS Projects Registry — TODO

## Done

- [x] **1. Add new Bioversity projects to the tool**
  Bulk Anaplan import: drop multiple `.csv`/`.xlsx` files at `/admin/imports`, auto-detect 4.1 vs 4.3, run 4.1 first then 4.3, per-file report with stat tiles + filterable error table. 4.1 auto-creates new projects when the code is new (center resolved from `Entity` column). Silent skips now show explicit reasons. Over-length text cells truncate with a warning instead of failing the row.

- [x] **2. Scope project visibility per center**
  Already implemented across `ProjectsService.findAll`, `DashboardService` (admin/center/program summary methods + allocation-status + recent-activity), and `MappingsService.findAll`/`create`/lock-toggle. Center reps see only their center; program reps see only their program; admins see all. Known gaps tracked separately in item #9.

- [x] **3. Workflow Admin role + Needs Assistance queue**
  New `workflow_admin` role added (DB enum + migration). Mappings auto-flag when a program rep submits their 2nd counter-proposal on the same mapping; flag clears on agreement (NOT on round reopen). Workflow admin lands on `/needs-assistance` (workflow_admin only — admins not included), has full negotiation rights system-wide (counter, agree, remove, add-program, lock, reopen, chat) but is read-only on project metadata. Dashboard hidden until a workflow_admin view exists. Audit trail (`mapping_negotiations.actor_role`) widened to record real `admin`/`workflow_admin` actor roles instead of collapsing into `center_rep`. Shipped as commit `c0b7c38`.

- [x] **4. Unit Admin role (PPU/PCU) with post-submission edit rights**
  New `unit_admin` role added (DB enum + migration). `PATCH /projects/:id/metadata` accepts a whitelist of fields (`name`, `description`, `summary`, `results`, `funder`, `fundingSource`, `startDate`, `endDate`, `totalBudget`, `remainingBudget`) regardless of `negotiation_locked` state, with required `justification ≥ 5 chars` recorded on every audit row. Anaplan-sourced fields, `code`, `centerId`, and `countryIds` are explicitly excluded. New append-only `project_audit_events` table writes one row per changed field; admin edits via `PATCH /projects/:id` also record audit rows. New `GET /projects/:id/audit` endpoint (admin / unit_admin / workflow_admin) drives the Edit History panel on project detail. Snapshot creation widened to unit_admin and records `published_snapshots.created_by_role`. Top-level `/snapshots` route + Snapshots header pill for unit_admin (admin still reaches it via `/admin/snapshots`). Pre-existing `published_projects.name varchar(255)` overflow bug fixed (widened to 1000) — surfaced during QA when 13 projects had names up to 504 chars. Migrations: `AddUnitAdminRole`, `AddProjectAuditEvents`, `AddCreatedByRoleToPublishedSnapshots`, `SeedUnitAdminDevUser`, `WidenPublishedProjectName`. QA: 52/52 backend assertions PASS, 6/6 UI flows PASS (audit panel infinite-loop bug found and fixed during E3).

## Remaining

- [ ] **5. Track admin role activities and changes (audit log)**
  Audit trail for actions taken by Admin / Workflow Admin / Unit Admin: who (name + email + role), what changed (before/after diff), when (millisecond timestamp), how (request ID). Covers project create/update/delete, mapping events (mirrored), user role changes, dev-login impersonation, snapshot publishes, CSV imports, and CLARISA syncs. Surface as `/admin/audit-log` viewer with filters + per-entity Activity tabs on project detail and user dialog.
  **Plan:** [`.claude/plans/task-05-admin-audit-log.md`](.claude/plans/task-05-admin-audit-log.md) — single unified `audit_events` table, `AuditService.record()` injected into every write path, role-scoped visibility (admin sees all, workflow_admin sees project/mapping/snapshot, unit_admin sees own + metadata edits), 7 open questions to confirm at kickoff. Coordinate with Task #4 if both unstarted (see plan §6 step 1).

- [x] **6. Budget-focused projects dashboard**
  `/projects` is now a budget command center: 5 KPI tiles (Active count, Total Pledged, Total Budget FY26, Mapped %, Suggested to reach 90%), default status = Active, sortable Budget FY26 + Mapped % + Total Pledged columns, hide Center filter/column for non-admins. Mapped % counts agreed mappings only (negotiating excluded). Backend: `GET /projects` extended with `budget2026`/`agreedAllocatedPercent`/sort whitelist, new `GET /projects/summary`, new `GET /projects/suggested-to-reach-target` (greedy picker — eligibility: `budget2026 > 0`, no `negotiating` rows, `agreedPercent < 100`). Suggested set highlights rows with 🎯 chip + accent border; tile click filters table to the set.

- [x] **7. Read-only summary row above projects table**
  Superseded by #6 — the KPI strip above the table covers this. Mapped % tile colours green ≥ 90%, orange below.

- [x] **8. 90% mapping helper checkboxes (Excel-style what-if)**
  Per-row checkboxes added (leftmost column). 6th KPI tile "What-if Selection" shows projected mapped % + delta + added budget as the user ticks rows. Cross-page selection persists; filter changes clear it. "Use suggested set" toolbar button bulk-ticks the greedy suggestion (then shows backend's authoritative 90% projection via short-circuit). **Known limitation:** if the user diverges from the full suggested set by unticking one row, projected % falls sharply because the client-side cache only has visible-page rows. Fix planned: extend `/projects/suggested-to-reach-target` to return per-project unmapped contributions so the client can subtract precisely. Tracked separately.

- [ ] **10. Set up a proper staging environment (and re-gate dev-login)**
  Currently `dev-login` / `dev-token` endpoints and the admin "Log in as user" button are **hardcoded open** (no env gate) so the deployed dev server can use them. This is unsafe for any future production deploy. Plan: add a `staging` Angular configuration + `environment.staging.ts` (`production: false`), make the web Dockerfile take a `BUILD_CONFIGURATION` ARG, add `docker-compose.staging.yml` with `ALLOW_DEV_LOGIN=true` on the api, and re-gate `auth.controller.ts:devLogin/devToken` + the user-list `isDev` flag on `ALLOW_DEV_LOGIN === 'true' || NODE_ENV === 'development'`. Once staging is live, the prod compose should leave the flag unset so dev-login is denied.

- [ ] **9. Close remaining center-scoping gaps (follow-up to #2)**
  Four specific holes found during the #2 audit (Apr 26):
  1. `GET /projects/:id` has no per-user access guard — any authenticated user can fetch any project by ID. Add admin/center/program/no-role check in `ProjectsService.findOne`.
  2. `GET /projects` list has no `PROGRAM_REP` branch — program reps currently see all projects. Add scoping by non-removed mappings to their program.
  3. Role-less users (`user.role === null`) fall through to `getAdminSummary` in `DashboardService.getSummary` `default` case — leaks admin data. Return zeroed/empty shape instead.
  4. `DashboardService.getAllocationStatus` has no `PROGRAM_REP` scoping — program reps see all projects in that table.
