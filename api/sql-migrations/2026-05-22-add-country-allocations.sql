-- ============================================================================
-- Per-country allocation % + split global flags — production deployment
-- ----------------------------------------------------------------------------
-- Migration  : AddCountryAllocations1784000000000
-- File       : api/src/database/migrations/1784000000000-AddCountryAllocations.ts
-- Purpose    : Switches `project_countries` (Location of Benefit) and
--              `project_implementation_countries` (Country of Implementation)
--              from plain M2M junctions to junction entities carrying
--              `allocation_percentage decimal(5,2)`.
--              Replaces the single `projects.is_global` boolean with two
--              independent per-table flags (`is_benefit_global`,
--              `is_implementation_global`). Legacy `is_global` value seeds
--              `is_benefit_global` (Location-of-Benefit semantics).
-- Backfill   : Existing rows on both junctions are distributed evenly
--              (`100 / count` per row, rounded to 2 dp; the row with the
--              highest country_id per project absorbs any rounding residue
--              so each project's allocations sum to exactly 100).
-- TypeORM    : Final INSERT records the migration in the `migrations` table
--              so `npm run migration:run` will skip it cleanly afterwards.
-- ============================================================================

START TRANSACTION;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Add allocation_percentage to both junction tables (nullable for backfill)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE `project_countries`
  ADD COLUMN `allocation_percentage` DECIMAL(5,2) NULL
  AFTER `country_id`;

ALTER TABLE `project_implementation_countries`
  ADD COLUMN `allocation_percentage` DECIMAL(5,2) NULL
  AFTER `country_id`;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Add the two per-table Global flags; seed is_benefit_global from is_global
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE `projects`
  ADD COLUMN `is_benefit_global` BOOLEAN NOT NULL DEFAULT false
  AFTER `is_global`;

ALTER TABLE `projects`
  ADD COLUMN `is_implementation_global` BOOLEAN NOT NULL DEFAULT false
  AFTER `is_benefit_global`;

UPDATE `projects` SET `is_benefit_global` = `is_global`;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Backfill allocations — distribute 100 / N evenly across each project's
--    rows. Highest country_id per project absorbs the rounding residue so
--    every project sums to exactly 100.
-- ────────────────────────────────────────────────────────────────────────────

-- 3a. project_countries — non-last rows: base = ROUND(100/N, 2)
UPDATE `project_countries` t
JOIN (
  SELECT project_id,
         COUNT(*) AS n,
         MAX(country_id) AS last_country_id
    FROM `project_countries`
   GROUP BY project_id
) s ON s.project_id = t.project_id
SET t.allocation_percentage = ROUND(100 / s.n, 2)
WHERE t.country_id <> s.last_country_id;

-- 3b. project_countries — last row per project: 100 - sum(non-last)
UPDATE `project_countries` t
JOIN (
  SELECT project_id,
         MAX(country_id) AS last_country_id,
         COUNT(*) AS n
    FROM `project_countries`
   GROUP BY project_id
) s ON s.project_id = t.project_id AND s.last_country_id = t.country_id
SET t.allocation_percentage = ROUND(100 - ROUND(100 / s.n, 2) * (s.n - 1), 2);

-- 3c. project_implementation_countries — non-last rows
UPDATE `project_implementation_countries` t
JOIN (
  SELECT project_id,
         COUNT(*) AS n,
         MAX(country_id) AS last_country_id
    FROM `project_implementation_countries`
   GROUP BY project_id
) s ON s.project_id = t.project_id
SET t.allocation_percentage = ROUND(100 / s.n, 2)
WHERE t.country_id <> s.last_country_id;

-- 3d. project_implementation_countries — last row per project
UPDATE `project_implementation_countries` t
JOIN (
  SELECT project_id,
         MAX(country_id) AS last_country_id,
         COUNT(*) AS n
    FROM `project_implementation_countries`
   GROUP BY project_id
) s ON s.project_id = t.project_id AND s.last_country_id = t.country_id
SET t.allocation_percentage = ROUND(100 - ROUND(100 / s.n, 2) * (s.n - 1), 2);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Tighten allocation_percentage to NOT NULL now that backfill is complete
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE `project_countries`
  MODIFY COLUMN `allocation_percentage` DECIMAL(5,2) NOT NULL;

ALTER TABLE `project_implementation_countries`
  MODIFY COLUMN `allocation_percentage` DECIMAL(5,2) NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Drop the legacy single is_global column (is_benefit_global carries it)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE `projects` DROP COLUMN `is_global`;

-- ────────────────────────────────────────────────────────────────────────────
-- Record migration so TypeORM's `migration:run` skips this one in the future
-- ────────────────────────────────────────────────────────────────────────────
INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1784000000000, 'AddCountryAllocations1784000000000');

COMMIT;

-- ============================================================================
-- Verification queries (run AFTER commit, separately):
--
--   -- Every project's Location-of-Benefit countries should sum to 100:
--   SELECT project_id, ROUND(SUM(allocation_percentage), 2) AS total
--     FROM project_countries GROUP BY project_id
--    HAVING total <> 100;
--
--   -- Same for Country of Implementation:
--   SELECT project_id, ROUND(SUM(allocation_percentage), 2) AS total
--     FROM project_implementation_countries GROUP BY project_id
--    HAVING total <> 100;
--
--   -- Confirm columns exist on projects:
--   SHOW COLUMNS FROM `projects` LIKE 'is_%global';
--
--   -- Confirm is_global is gone:
--   SHOW COLUMNS FROM `projects` LIKE 'is_global';   -- should return 0 rows
-- ============================================================================
