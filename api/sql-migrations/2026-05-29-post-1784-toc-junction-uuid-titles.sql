-- ============================================================================
-- Post `AddCountryAllocations1784000000000` deployment bundle (idempotent)
-- ----------------------------------------------------------------------------
-- Generated  : 2026-05-29
-- Target     : Production DB whose latest applied migration is
--                AddCountryAllocations1784000000000  (timestamp 1784000000000)
-- Covers     : 3 TypeORM migrations + 1 data backfill
--                1785000000000-AddTocOutcomeAowsJunction
--                1786000000000-AddProgramOriginalId
--                1787000000000-WidenTocTitleColumns
--                + UPDATE programs.original_id (13 rows; values sourced
--                  from the Planning DB initiatives.action_area_id)
--
-- MySQL compatibility
-- -------------------
-- Avoids every MySQL 8.0.29+ DDL extension:
--   * NO `ADD COLUMN IF NOT EXISTS`     (added in 8.0.29)
--   * NO `DROP COLUMN IF EXISTS`        (added in 8.0.29)
--   * NO `CREATE INDEX IF NOT EXISTS`   (not supported)
--   * NO `ADD CONSTRAINT IF NOT EXISTS` (not supported)
--
-- Every conditional DDL runs inside a stored procedure that checks
-- `information_schema` first, so each section is safe to re-run.
-- Tested for MySQL 8.0.16+. Matches the precedent set by
-- `2026-05-20-post-widen-published-name.sql`.
--
-- Client compatibility
-- --------------------
-- Uses `DELIMITER $$ ... DELIMITER ;` to define procedures. Supported by:
--   * mysql CLI        OK
--   * phpMyAdmin       OK  (target client for this deploy)
--   * MySQL Workbench  OK
-- If pasted into a GUI that doesn't parse DELIMITER, run via:
--     mysql -u <user> -p <db> < 2026-05-29-post-1784-toc-junction-uuid-titles.sql
--
-- No outer transaction
-- --------------------
-- DDL in MySQL auto-commits. Sections are ordered so a failure mid-run
-- leaves the DB in a state where re-running this script picks up
-- where it stopped — every operation is conditional.
--
-- Manual follow-up after this script
-- ----------------------------------
-- Once this completes successfully, the operator must:
--   1. Restart the PRMS API (so it picks up env-var changes if any).
--   2. Trigger a TOC re-sync — programs whose `original_id` was
--      populated by Section 4 will pull the richer working-draft TOC
--      content; programs without one fall back to the official-code
--      endpoint. The re-sync also repopulates `toc_outcome_aows` per
--      the current `group`-only resolution.
-- ============================================================================


-- ============================================================================
-- Section 1 — AddTocOutcomeAowsJunction1785000000000
--   1a. CREATE TABLE `toc_outcome_aows` if missing.
--   1b. Backfill from `toc_outcomes.aow_id` (legacy scalar) where set.
-- ============================================================================

DROP PROCEDURE IF EXISTS `__prms_apply_toc_outcome_aows`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_toc_outcome_aows`()
BEGIN
  DECLARE table_exists INT DEFAULT 0;

  SELECT COUNT(*) INTO table_exists
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name   = 'toc_outcome_aows';

  IF table_exists = 0 THEN
    CREATE TABLE `toc_outcome_aows` (
      `outcome_id` int NOT NULL,
      `aow_id` int NOT NULL,
      PRIMARY KEY (`outcome_id`, `aow_id`),
      INDEX `IDX_toc_outcome_aows_aow` (`aow_id`),
      CONSTRAINT `FK_toc_outcome_aows_outcome` FOREIGN KEY (`outcome_id`)
        REFERENCES `toc_outcomes` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION,
      CONSTRAINT `FK_toc_outcome_aows_aow` FOREIGN KEY (`aow_id`)
        REFERENCES `toc_aows` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

    /* Seed from the existing scalar FK. The composite PK protects
     * against duplicate (outcome_id, aow_id) rows if this runs twice. */
    INSERT INTO `toc_outcome_aows` (`outcome_id`, `aow_id`)
    SELECT `id`, `aow_id`
      FROM `toc_outcomes`
     WHERE `aow_id` IS NOT NULL;
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_toc_outcome_aows`();
DROP PROCEDURE `__prms_apply_toc_outcome_aows`;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1785000000000, 'AddTocOutcomeAowsJunction1785000000000');


-- ============================================================================
-- Section 2 — AddProgramOriginalId1786000000000
--   2a. ADD COLUMN `programs.original_id varchar(36) NULL` if missing.
--   2b. CREATE INDEX `IDX_programs_original_id` if missing.
-- ============================================================================

DROP PROCEDURE IF EXISTS `__prms_apply_programs_original_id`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_programs_original_id`()
BEGIN
  DECLARE c INT DEFAULT 0;

  SELECT COUNT(*) INTO c
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'programs'
      AND column_name  = 'original_id';

  IF c = 0 THEN
    ALTER TABLE `programs`
      ADD COLUMN `original_id` VARCHAR(36) NULL;
  END IF;

  SELECT COUNT(*) INTO c
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name   = 'programs'
      AND index_name   = 'IDX_programs_original_id';

  IF c = 0 THEN
    CREATE INDEX `IDX_programs_original_id`
      ON `programs` (`original_id`);
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_programs_original_id`();
DROP PROCEDURE `__prms_apply_programs_original_id`;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1786000000000, 'AddProgramOriginalId1786000000000');


-- ============================================================================
-- Section 3 — WidenTocTitleColumns1787000000000
--   3a. toc_outcomes.title  : widen to varchar(1000) if currently narrower.
--   3b. toc_outputs.title   : widen to varchar(1000) if currently narrower.
-- ----------------------------------------------------------------------------
-- ALTER TABLE ... MODIFY COLUMN to a wider VARCHAR in the same byte-length
-- bucket (>255 in both cases) is an INSTANT metadata change in MySQL 8.0+,
-- no row rewrite, no copy. Safe in prod.
-- ============================================================================

DROP PROCEDURE IF EXISTS `__prms_widen_toc_titles`;
DELIMITER $$
CREATE PROCEDURE `__prms_widen_toc_titles`()
BEGIN
  DECLARE current_len INT DEFAULT 0;

  SELECT character_maximum_length INTO current_len
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'toc_outcomes'
      AND column_name  = 'title';

  IF current_len IS NOT NULL AND current_len < 1000 THEN
    ALTER TABLE `toc_outcomes`
      MODIFY COLUMN `title` VARCHAR(1000) NULL;
  END IF;

  SELECT character_maximum_length INTO current_len
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name   = 'toc_outputs'
      AND column_name  = 'title';

  IF current_len IS NOT NULL AND current_len < 1000 THEN
    ALTER TABLE `toc_outputs`
      MODIFY COLUMN `title` VARCHAR(1000) NULL;
  END IF;
END$$
DELIMITER ;

CALL `__prms_widen_toc_titles`();
DROP PROCEDURE `__prms_widen_toc_titles`;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1787000000000, 'WidenTocTitleColumns1787000000000');


-- ============================================================================
-- Section 4 — DATA: populate programs.original_id from Planning DB
-- ----------------------------------------------------------------------------
-- Not a migration — a one-shot data load. Idempotent: every UPDATE is keyed
-- on official_code and overwrites with the same value on re-run. UUIDs were
-- captured from the Planning DB's `initiatives.action_area_id` column on
-- 2026-05-29 (see also: /Users/moayad/Downloads/programs.sql, the upstream
-- dump).
--
-- Without this section TocSyncService still works — it falls back to
-- /api/toc/{officialCode} for any program whose original_id is NULL —
-- but the picker will keep showing the stale published-snapshot
-- content instead of the working-draft content.
-- ============================================================================

UPDATE `programs` SET `original_id` = 'dc81f773-4dbd-408e-ad02-9b8fa9e072bf' WHERE `official_code` = 'SP01';
UPDATE `programs` SET `original_id` = 'f0616372-9285-4f6d-8769-edcefbb54354' WHERE `official_code` = 'SP02';
UPDATE `programs` SET `original_id` = '73c765c0-f217-45b2-98f0-d13f6b3f8b11' WHERE `official_code` = 'SP03';
UPDATE `programs` SET `original_id` = '438bbe30-ed45-42d1-bf50-87122f7b90d3' WHERE `official_code` = 'SP04';
UPDATE `programs` SET `original_id` = 'ca63d124-8943-49fc-bc56-95497ef15191' WHERE `official_code` = 'SP05';
UPDATE `programs` SET `original_id` = '623a3e31-27fc-41e3-b487-60e460abcdf9' WHERE `official_code` = 'SP06';
UPDATE `programs` SET `original_id` = '40259386-62bf-420b-9b7f-6041bdd4e9a1' WHERE `official_code` = 'SP07';
UPDATE `programs` SET `original_id` = '4eefa55d-6a3e-4190-b158-a9d122e08826' WHERE `official_code` = 'SP08';
UPDATE `programs` SET `original_id` = 'a5b6ffc9-17e6-4cba-bef9-edc4eb572a0b' WHERE `official_code` = 'SP09';
UPDATE `programs` SET `original_id` = 'ce04e9b8-690b-4f49-8d3b-68b6d97a8b9b' WHERE `official_code` = 'SP10';
UPDATE `programs` SET `original_id` = '66f3140b-fec9-47e8-91ab-1fe8f26bbf40' WHERE `official_code` = 'SP11';
UPDATE `programs` SET `original_id` = '6749c68a-0955-417e-8bc2-6dc5102be063' WHERE `official_code` = 'SP12';
UPDATE `programs` SET `original_id` = '39e86294-d092-4949-bb34-8857b4d5f021' WHERE `official_code` = 'SP13';


-- ============================================================================
-- Verification queries (read-only — leave these to run after the script)
-- ============================================================================

-- 1. All four targets succeeded in the migrations table:
--    SELECT `timestamp`, `name` FROM `migrations`
--     WHERE `timestamp` BETWEEN 1785000000000 AND 1787000000000
--     ORDER BY `timestamp`;
--
-- 2. Junction exists and was backfilled from the legacy scalar:
--    SELECT COUNT(*) AS junction_rows FROM `toc_outcome_aows`;
--    SELECT COUNT(*) AS legacy_rows
--      FROM `toc_outcomes` WHERE `aow_id` IS NOT NULL;
--    (junction_rows should equal legacy_rows immediately after this script;
--     the next TOC sync may add or remove rows as `group`-only resolution
--     reapplies.)
--
-- 3. UUIDs populated on every program:
--    SELECT `official_code`, `name`, `original_id`
--      FROM `programs`
--     ORDER BY `official_code`;
--
-- 4. Title columns widened:
--    SELECT table_name, column_name, character_maximum_length
--      FROM information_schema.columns
--     WHERE table_schema = DATABASE()
--       AND table_name IN ('toc_outcomes', 'toc_outputs')
--       AND column_name = 'title';
