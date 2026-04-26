# PRMS Projects Registry — TODO

## Done

- [x] **1. Add new Bioversity projects to the tool**
  Bulk Anaplan import: drop multiple `.csv`/`.xlsx` files at `/admin/imports`, auto-detect 4.1 vs 4.3, run 4.1 first then 4.3, per-file report with stat tiles + filterable error table. 4.1 auto-creates new projects when the code is new (center resolved from `Entity` column). Silent skips now show explicit reasons. Over-length text cells truncate with a warning instead of failing the row.

- [x] **2. Scope project visibility per center**
  Already implemented across `ProjectsService.findAll`, `DashboardService` (admin/center/program summary methods + allocation-status + recent-activity), and `MappingsService.findAll`/`create`/lock-toggle. Center reps see only their center; program reps see only their program; admins see all. Known gaps tracked separately in item #9.

## Remaining

- [ ] **3. Workflow Admin role + "action needed" Admin tab**
  New role for one system-office user. When a project has no agreement / no negotiation activity, auto-flag it for the Workflow Admin. Add an Admin tab listing flagged projects so the Workflow Admin can decide.

- [ ] **4. Unit Admin role (PPU/PCU) with post-submission edit rights**
  New role for PPU/PCU admins. Can edit a defined whitelist of project metadata fields *even after submission/lock*. Anaplan-sourced fields stay read-only. Editable-field list to be specified when we start.
  **Plan:** [`.claude/plans/task-04-unit-admin-editor-role.md`](.claude/plans/task-04-unit-admin-editor-role.md) — covers role enum + migration, `project_audit_events` table, `PATCH /projects/:id/metadata` endpoint, snapshot-republish widening, frontend field gating + audit tab, and 6 open questions to confirm at kickoff. Depends on Task #3 landing first.

- [ ] **5. Track admin role activities and changes (audit log)**
  Audit trail for actions taken by Admin / Workflow Admin / Unit Admin: who, what changed (before/after), when. Surface a viewer for these logs.

- [ ] **6. Budget-focused projects dashboard (formerly "Budget for 2026 column")**
  Reframe `/projects` as a budget command center: KPI strip (active projects, total pledged, FY26 budget, mapped %), default status = Active, sortable Budget 2026 + Mapped % columns, hide Center filter/column for non-admins. Mapped % counts agreed mappings only (negotiating excluded) — green ≥ 90%, orange < 90%. Plan: `~/.claude/plans/okay-there-is-another-synchronous-harbor.md`.

- [ ] **7. Read-only summary row above projects table**
  Header strip showing: total of all projects (count/budget), total budget mapped, and the mapped percentage. Color the percentage red if `<90%`, green if `>=90%`. No submission rule on 90% — visual indicator only.

- [ ] **8. 90% mapping helper checkboxes (Excel-style what-if)**
  Per-row checkbox on the projects table. Ticking a project adds its budget into a running what-if total + percentage in the header summary, to help users plan toward 90%. Does NOT create mappings or persist — purely a calculator aid.

- [ ] **9. Close remaining center-scoping gaps (follow-up to #2)**
  Four specific holes found during the #2 audit (Apr 26):
  1. `GET /projects/:id` has no per-user access guard — any authenticated user can fetch any project by ID. Add admin/center/program/no-role check in `ProjectsService.findOne`.
  2. `GET /projects` list has no `PROGRAM_REP` branch — program reps currently see all projects. Add scoping by non-removed mappings to their program.
  3. Role-less users (`user.role === null`) fall through to `getAdminSummary` in `DashboardService.getSummary` `default` case — leaks admin data. Return zeroed/empty shape instead.
  4. `DashboardService.getAllocationStatus` has no `PROGRAM_REP` scoping — program reps see all projects in that table.
