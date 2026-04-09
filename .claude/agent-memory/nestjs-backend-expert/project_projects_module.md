---
name: Projects Module
description: BE-3.1 to BE-3.3 — Project entity, CRUD service, controller, migration, enums (ProjectStatus, FundingSource)
type: project
---

Wave 3 backend (BE-3.1 through BE-3.3) implemented the Projects module.

**Entity**: Project extends BaseEntity with code (unique), name, description, summary, results, startDate, endDate, totalBudget (decimal 10,2), remainingBudget, fundingSource (enum), funder, status (enum), centerId FK, createdById FK, ManyToMany countries via project_countries join table.

**Enums**: ProjectStatus (draft, active, archived), FundingSource (window3, bilateral, srv, other).

**Service**: CRUD with create (duplicate code check, center/country validation), findAll (QueryBuilder with search/filter/pagination), findOne (loads relations), update (partial, handles country replacement), archive (soft delete via status change).

**Controller**: GET /projects (list), GET /projects/:id, POST /projects (admin), PATCH /projects/:id (admin), DELETE /projects/:id (admin, 204 archive).

**Migration fix**: Pre-existing collation mismatch between users table (utf8mb4_general_ci) and reference data tables (utf8mb4_0900_ai_ci). Fixed in AddForeignKeysToUsers migration by converting users table to utf8mb4_0900_ai_ci before adding FKs.

**Why:** Collation incompatibility was caused by the users table being created without explicit charset (inheriting server default general_ci) while reference data tables specified DEFAULT CHARSET=utf8mb4 which uses 0900_ai_ci on MySQL 8.

**How to apply:** All future CREATE TABLE statements should use `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4` to match the standardized collation.
