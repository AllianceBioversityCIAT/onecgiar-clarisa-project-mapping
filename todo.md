# PRMS Projects Registry — TODO

## Done

- [x] **1. Add new Bioversity projects to the tool**
  Bulk Anaplan import: drop multiple `.csv`/`.xlsx` files at `/admin/imports`, auto-detect 4.1 vs 4.3, run 4.1 first then 4.3, per-file report with stat tiles + filterable error table. 4.1 auto-creates new projects when the code is new (center resolved from `Entity` column). Silent skips now show explicit reasons. Over-length text cells truncate with a warning instead of failing the row.

- [x] **2. Scope project visibility per center**
  Already implemented across `ProjectsService.findAll`, `DashboardService` (admin/center/program summary methods + allocation-status + recent-activity), and `MappingsService.findAll`/`create`/lock-toggle. Center reps see only their center; program reps see only their program; admins see all. Known gaps tracked separately in item #9.

- [x] **3. Workflow Admin role + Needs Assistance queue**
  New `workflow_admin` role added (DB enum + migration). Mappings auto-flag when a program rep submits their 2nd counter-proposal on the same mapping; flag clears on agreement (NOT on round reopen). Workflow admin lands on `/needs-assistance` (workflow_admin only — admins not included), has full negotiation rights system-wide (counter, agree, remove, add-program, lock, reopen, chat) but is read-only on project metadata. Dashboard hidden until a workflow_admin view exists. Audit trail (`mapping_negotiations.actor_role`) widened to record real `admin`/`workflow_admin` actor roles instead of collapsing into `center_rep`. Shipped as commit `c0b7c38`.

## Remaining

- [ ] **4. Unit Admin role (PPU/PCU) with post-submission edit rights**
  New role for PPU/PCU admins. Can edit a defined whitelist of project metadata fields *even after submission/lock*. Anaplan-sourced fields stay read-only. Editable-field list to be specified when we start.
  **Plan:** [`.claude/plans/task-04-unit-admin-editor-role.md`](.claude/plans/task-04-unit-admin-editor-role.md) — covers role enum + migration, `project_audit_events` table, `PATCH /projects/:id/metadata` endpoint, snapshot-republish widening, frontend field gating + audit tab, and 6 open questions to confirm at kickoff. Depends on Task #3 landing first.

- [ ] **5. Track admin role activities and changes (audit log)**
  Audit trail for actions taken by Admin / Workflow Admin / Unit Admin: who, what changed (before/after), when. Surface a viewer for these logs.

- [x] **6. Budget-focused projects dashboard**
  `/projects` is now a budget command center: 5 KPI tiles (Active count, Total Pledged, Total Budget FY26, Mapped %, Suggested to reach 90%), default status = Active, sortable Budget FY26 + Mapped % + Total Pledged columns, hide Center filter/column for non-admins. Mapped % counts agreed mappings only (negotiating excluded). Backend: `GET /projects` extended with `budget2026`/`agreedAllocatedPercent`/sort whitelist, new `GET /projects/summary`, new `GET /projects/suggested-to-reach-target` (greedy picker — eligibility: `budget2026 > 0`, no `negotiating` rows, `agreedPercent < 100`). Suggested set highlights rows with 🎯 chip + accent border; tile click filters table to the set.

- [x] **7. Read-only summary row above projects table**
  Superseded by #6 — the KPI strip above the table covers this. Mapped % tile colours green ≥ 90%, orange below.

- [x] **8. 90% mapping helper checkboxes (Excel-style what-if)**
  Per-row checkboxes added (leftmost column). 6th KPI tile "What-if Selection" shows projected mapped % + delta + added budget as the user ticks rows. Cross-page selection persists; filter changes clear it. "Use suggested set" toolbar button bulk-ticks the greedy suggestion (then shows backend's authoritative 90% projection via short-circuit). **Known limitation:** if the user diverges from the full suggested set by unticking one row, projected % falls sharply because the client-side cache only has visible-page rows. Fix planned: extend `/projects/suggested-to-reach-target` to return per-project unmapped contributions so the client can subtract precisely. Tracked separately.

- [ ] **9. Close remaining center-scoping gaps (follow-up to #2)**
  Four specific holes found during the #2 audit (Apr 26):
  1. `GET /projects/:id` has no per-user access guard — any authenticated user can fetch any project by ID. Add admin/center/program/no-role check in `ProjectsService.findOne`.
  2. `GET /projects` list has no `PROGRAM_REP` branch — program reps currently see all projects. Add scoping by non-removed mappings to their program.
  3. Role-less users (`user.role === null`) fall through to `getAdminSummary` in `DashboardService.getSummary` `default` case — leaks admin data. Return zeroed/empty shape instead.
  4. `DashboardService.getAllocationStatus` has no `PROGRAM_REP` scoping — program reps see all projects in that table.
