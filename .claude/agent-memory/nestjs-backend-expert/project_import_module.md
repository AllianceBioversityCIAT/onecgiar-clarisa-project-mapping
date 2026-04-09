---
name: Import Module
description: BE-6.1/6.2: CSV import service and admin controller for bulk project/mapping data from TOC_Projects.csv
type: project
---

Wave 6 implemented CSV import module at `src/modules/import/`.

**Components:**
- `ImportService` — reads TOC_Projects.csv, groups by project name, upserts projects and mappings with per-project transactions
- `ImportController` — `POST /api/admin/import-csv`, admin-only, idempotent
- `ImportModule` — registered in AppModule

**Key design decisions:**
- System user (`system@prms.cgiar.org`) auto-created for `createdBy`/`submittedBy` foreign keys
- CSV allocation is decimal (0.5 = 50%), multiplied by 100 for DB storage
- Code extraction uses regex pattern matching on the Name column prefix
- Center resolution uses multi-strategy matching (exact, acronym, partial, word-based)
- Per-project transaction with EntityManager for atomicity
- Progress logged every 50 projects at info level

**Why:** The CSV has 472 rows but ~283 unique projects; same project appears multiple times for different program mappings.

**How to apply:** Import is idempotent — re-running updates existing records. The endpoint is admin-restricted via @Roles guard.
