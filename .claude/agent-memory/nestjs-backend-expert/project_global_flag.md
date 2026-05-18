---
name: project-global-flag
description: Project-level isGlobal flag — "Global wins" over countries, drives form UI and TOC importer Location column
metadata:
  type: project
---

`projects.is_global` BOOLEAN NOT NULL DEFAULT false (migration `1777000000000-AddIsGlobalToProjects.ts`). When true, the project has no country-specific scope and the `project_countries` join must be empty.

**Why:** Some CGIAR projects span all geographies; tracking a finite country list misrepresents them. Anaplan TOC export carries this as `Location = "Global"`.

**How to apply:**
- Mutual exclusion is enforced at the **service layer**, not via DB trigger. Service code in `projects.service.ts` (`create`, `update`) and `import.service.ts` (`importTocFromBuffer`) implements "Global wins" — if `isGlobal=true` is set, countries are forced to `[]` regardless of any `countryIds` sent.
- `isGlobal` is in `AUDITABLE_FIELDS` (line ~309) and in the create-snapshot `snapshotFields` (line ~493) so flips are recorded in `project_audit_events`.
- DTO uses the boolean Transform pattern (`'true'/'1' -> true`, `'false'/'0' -> false`) copied from `project-query.dto.ts` — supports both JSON bodies and URL-encoded form submissions.
- `UpdateProjectDto` inherits via `PartialType(OmitType(CreateProjectDto, [...]))`; `isGlobal` is NOT in the omit list, so it flows through to PATCH automatically.
- Deliberately excluded from `UnitAdminUpdateProjectDto` — Global is a structural flag, not narrative metadata.
- TOC importer derives `isGlobal = primaryRow.Location.trim().toLowerCase() === 'global'`. Both the raw-SQL INSERT branch (CSV ID path) and QueryBuilder INSERT branch (auto-ID path) set it. Country join-table writes are skipped when global.
