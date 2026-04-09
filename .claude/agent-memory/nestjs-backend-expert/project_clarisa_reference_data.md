---
name: CLARISA Sync & Reference Data
description: Wave 2 (BE-2.1 to BE-2.4): CLARISA HTTP client, reference data entities (centers, programs, countries, action_areas), sync service with bootstrap seeding, admin sync endpoint, cached REST endpoints
type: project
---

Wave 2 implemented CLARISA integration and reference data management.

**Why:** PRMS needs CGIAR organizational reference data (centers, programs/initiatives, countries, action areas) sourced from the CLARISA external API to populate dropdowns and establish foreign-key relationships (e.g., users belong to a center/program).

**How to apply:**
- ClarisaModule is @Global() so ClarisaService can be injected anywhere without imports
- Reference data tables use `clarisa_id` (int, unique) as the external identifier for upsert matching
- On app startup, if `centers` table is empty, auto-sync runs
- Admin can manually trigger sync via POST /api/admin/sync-clarisa
- GET endpoints (/centers, /programs, /countries, /action-areas) use 5-minute in-memory cache
- User entity has ManyToOne relations to Program and Center with proper FK constraints
- Two migrations: CreateReferenceDataTables (timestamp ...468) then AddForeignKeysToUsers (timestamp ...469)
