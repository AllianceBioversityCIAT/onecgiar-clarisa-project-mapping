-- ============================================================================
-- Post `WidenPublishedProjectName1776300400000` deployment bundle (idempotent)
-- ----------------------------------------------------------------------------
-- Generated  : 2026-05-20 (re-issued idempotent for MySQL 8.0.16-8.0.28)
-- Target     : Production DB whose latest applied migration is
--                WidenPublishedProjectName1776300400000
-- Covers     : 13 TypeORM migrations between
--                1776400000000-AddAuditEventsUnified
--                ...
--                1782000000000-AddProjectImplementationCountries
--
-- MySQL compatibility
-- -------------------
-- This revision avoids every MySQL 8.0.29+ DDL extension:
--   * NO `ADD COLUMN IF NOT EXISTS`     (added in 8.0.29)
--   * NO `DROP COLUMN IF EXISTS`        (added in 8.0.29)
--   * NO `ADD INDEX IF NOT EXISTS`      (not supported in MySQL at all)
--   * NO `ADD CONSTRAINT IF NOT EXISTS` (not supported)
--
-- Instead every conditional DDL statement runs inside a stored procedure that
-- checks `information_schema` first, so every section is safe on a partial
-- re-run. Tested for MySQL 8.0.16+ (when CHECK constraints became enforced,
-- which Section 11 relies on).
--
-- Client compatibility
-- --------------------
-- Uses `DELIMITER $$ … DELIMITER ;` to define procedures. Supported by:
--   * mysql CLI        ✅
--   * phpMyAdmin       ✅  (target client for this deploy)
--   * MySQL Workbench  ✅
-- If you ever paste this into a generic GUI that does not parse DELIMITER,
-- run via the mysql CLI instead:
--     mysql -u <user> -p <db> < 2026-05-20-post-widen-published-name.sql
--
-- No outer transaction
-- --------------------
-- DDL in MySQL auto-commits — wrapping `ALTER TABLE` / `CREATE TABLE` /
-- `CREATE PROCEDURE` in `START TRANSACTION` is meaningless. Section 1's
-- parity check still aborts the run via SIGNAL SQLSTATE '45000' if the
-- data copy diverges from the legacy table count.
-- ============================================================================


-- ============================================================================
-- Section 1 — AddAuditEventsUnified1776400000000
--   1a. CREATE TABLE IF NOT EXISTS audit_events.
--   1b. If `project_audit_events` still exists, copy rows + parity check + DROP.
-- ============================================================================

CREATE TABLE IF NOT EXISTS `audit_events` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `entity_type` ENUM(
    'project',
    'project_mapping',
    'user',
    'published_snapshot',
    'import_run',
    'clarisa_sync',
    'system'
  ) NOT NULL,
  `entity_id` INT NULL,
  `action` VARCHAR(64) NOT NULL,
  `actor_user_id` INT NULL,
  `actor_role` ENUM(
    'admin',
    'center_rep',
    'program_rep',
    'workflow_admin',
    'unit_admin',
    'system'
  ) NOT NULL,
  `actor_display_name` VARCHAR(255) NOT NULL,
  `actor_email` VARCHAR(255) NULL,
  `changes` JSON NULL,
  `summary` VARCHAR(500) NULL,
  `justification` TEXT NULL,
  `request_id` VARCHAR(64) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `idx_audit_entity` (`entity_type`, `entity_id`, `created_at` DESC),
  INDEX `idx_audit_actor` (`actor_user_id`, `created_at` DESC),
  INDEX `idx_audit_action` (`action`, `created_at` DESC),
  INDEX `idx_audit_created_at` (`created_at` DESC),
  CONSTRAINT `FK_audit_events_actor_user`
    FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP PROCEDURE IF EXISTS `__prms_apply_audit_events`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_audit_events`()
BEGIN
  DECLARE legacy_exists INT DEFAULT 0;
  DECLARE src_count BIGINT DEFAULT 0;
  DECLARE dst_count BIGINT DEFAULT 0;

  SELECT COUNT(*) INTO legacy_exists
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name   = 'project_audit_events';

  IF legacy_exists = 1 THEN
    INSERT INTO `audit_events` (
      `entity_type`, `entity_id`, `action`, `actor_user_id`, `actor_role`,
      `actor_display_name`, `actor_email`, `changes`, `summary`,
      `justification`, `request_id`, `created_at`
    )
    SELECT
      'project' AS entity_type,
      pae.project_id AS entity_id,
      CASE pae.event_type
        WHEN 'field_edited'         THEN 'project.metadata_update'
        WHEN 'snapshot_republished' THEN 'project.snapshot_republished'
      END AS action,
      pae.actor_user_id,
      CAST(pae.actor_role AS CHAR) AS actor_role,
      COALESCE(
        NULLIF(TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))), ''),
        u.email,
        '(unknown)'
      ) AS actor_display_name,
      u.email AS actor_email,
      CASE pae.event_type
        WHEN 'field_edited' THEN
          JSON_OBJECT(
            COALESCE(pae.field_name, '(unknown)'),
            JSON_OBJECT('before', pae.value_before, 'after', pae.value_after)
          )
        WHEN 'snapshot_republished' THEN NULL
      END AS changes,
      CASE pae.event_type
        WHEN 'field_edited'         THEN CONCAT('Edited field: ', COALESCE(pae.field_name, '(unknown)'))
        WHEN 'snapshot_republished' THEN 'Republished snapshot'
      END AS summary,
      pae.justification,
      NULL AS request_id,
      pae.created_at
    FROM `project_audit_events` pae
    LEFT JOIN `users` u ON u.id = pae.actor_user_id;

    SELECT COUNT(*) INTO src_count FROM `project_audit_events`;
    SELECT COUNT(*) INTO dst_count
      FROM `audit_events`
      WHERE entity_type = 'project'
        AND action IN ('project.metadata_update', 'project.snapshot_republished');

    IF src_count <> dst_count THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'AddAuditEventsUnified parity check failed: project_audit_events vs audit_events row count mismatch';
    END IF;

    DROP TABLE `project_audit_events`;
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_audit_events`();
DROP PROCEDURE `__prms_apply_audit_events`;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1776400000000, 'AddAuditEventsUnified1776400000000');


-- ============================================================================
-- Section 2 — AddNegotiationStartedEventType1776500000000
-- ============================================================================

ALTER TABLE `mapping_negotiations`
  MODIFY COLUMN `event_type`
  ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started')
  NOT NULL;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1776500000000, 'AddNegotiationStartedEventType1776500000000');


-- ============================================================================
-- Section 3 — AddProgramRepRemovalRequest1776600000000
--   Adds four `removal_*` columns, FK, and composite index — each gated on
--   information_schema since `ADD COLUMN IF NOT EXISTS` is 8.0.29+ only.
-- ============================================================================

DROP PROCEDURE IF EXISTS `__prms_apply_removal_request`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_removal_request`()
BEGIN
  DECLARE c INT DEFAULT 0;

  -- columns
  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'project_mappings'
      AND column_name = 'removal_requested';
  IF c = 0 THEN
    ALTER TABLE `project_mappings`
      ADD COLUMN `removal_requested` TINYINT(1) NOT NULL DEFAULT 0;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'project_mappings'
      AND column_name = 'removal_requested_by';
  IF c = 0 THEN
    ALTER TABLE `project_mappings`
      ADD COLUMN `removal_requested_by` INT NULL;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'project_mappings'
      AND column_name = 'removal_requested_at';
  IF c = 0 THEN
    ALTER TABLE `project_mappings`
      ADD COLUMN `removal_requested_at` DATETIME NULL;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'project_mappings'
      AND column_name = 'removal_justification';
  IF c = 0 THEN
    ALTER TABLE `project_mappings`
      ADD COLUMN `removal_justification` TEXT NULL;
  END IF;

  -- FK
  SELECT COUNT(*) INTO c FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'project_mappings'
      AND constraint_name = 'FK_project_mappings_removal_requested_by';
  IF c = 0 THEN
    ALTER TABLE `project_mappings`
      ADD CONSTRAINT `FK_project_mappings_removal_requested_by`
      FOREIGN KEY (`removal_requested_by`) REFERENCES `users`(`id`)
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  -- index
  SELECT COUNT(*) INTO c FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'project_mappings'
      AND index_name = 'IDX_project_mappings_project_removal_requested';
  IF c = 0 THEN
    CREATE INDEX `IDX_project_mappings_project_removal_requested`
      ON `project_mappings` (`project_id`, `removal_requested`);
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_removal_request`();
DROP PROCEDURE `__prms_apply_removal_request`;

ALTER TABLE `mapping_negotiations`
  MODIFY COLUMN `event_type`
  ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started','removal_requested','removal_declined')
  NOT NULL;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1776600000000, 'AddProgramRepRemovalRequest1776600000000');


-- ============================================================================
-- Section 4 — AddProjectExclusions1776700000000
-- ============================================================================

CREATE TABLE IF NOT EXISTS `project_exclusions` (
  `id`                  INT          NOT NULL AUTO_INCREMENT,
  `project_id`          INT          NOT NULL,
  `center_id`           INT          NOT NULL,
  `excluded_by_user_id` INT          NOT NULL,
  `reason`              TEXT         NOT NULL,
  `excluded_at`         DATETIME     NOT NULL,
  `created_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                              ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP PROCEDURE IF EXISTS `__prms_apply_project_exclusions`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_project_exclusions`()
BEGIN
  DECLARE c INT DEFAULT 0;

  SELECT COUNT(*) INTO c FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'project_exclusions'
      AND constraint_name = 'UQ_project_exclusions_project_center';
  IF c = 0 THEN
    ALTER TABLE `project_exclusions`
      ADD CONSTRAINT `UQ_project_exclusions_project_center`
      UNIQUE (`project_id`, `center_id`);
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'project_exclusions'
      AND index_name = 'IDX_project_exclusions_project_id';
  IF c = 0 THEN
    CREATE INDEX `IDX_project_exclusions_project_id`
      ON `project_exclusions` (`project_id`);
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'project_exclusions'
      AND index_name = 'IDX_project_exclusions_center_id';
  IF c = 0 THEN
    CREATE INDEX `IDX_project_exclusions_center_id`
      ON `project_exclusions` (`center_id`);
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'project_exclusions'
      AND constraint_name = 'FK_project_exclusions_project';
  IF c = 0 THEN
    ALTER TABLE `project_exclusions`
      ADD CONSTRAINT `FK_project_exclusions_project`
      FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'project_exclusions'
      AND constraint_name = 'FK_project_exclusions_center';
  IF c = 0 THEN
    ALTER TABLE `project_exclusions`
      ADD CONSTRAINT `FK_project_exclusions_center`
      FOREIGN KEY (`center_id`) REFERENCES `centers`(`id`)
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'project_exclusions'
      AND constraint_name = 'FK_project_exclusions_excluded_by_user';
  IF c = 0 THEN
    ALTER TABLE `project_exclusions`
      ADD CONSTRAINT `FK_project_exclusions_excluded_by_user`
      FOREIGN KEY (`excluded_by_user_id`) REFERENCES `users`(`id`)
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_project_exclusions`();
DROP PROCEDURE `__prms_apply_project_exclusions`;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1776700000000, 'AddProjectExclusions1776700000000');


-- ============================================================================
-- Section 5 — AddAnaplan2026ProjectFields1776800000000
--   Six new columns, gated. (No `ADD COLUMN IF NOT EXISTS` — 8.0.29+ only.)
-- ============================================================================

DROP PROCEDURE IF EXISTS `__prms_apply_anaplan_2026`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_anaplan_2026`()
BEGIN
  DECLARE c INT DEFAULT 0;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND column_name = 'email';
  IF c = 0 THEN
    ALTER TABLE `projects`
      ADD COLUMN `email` VARCHAR(255) NULL AFTER `principal_investigator`;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND column_name = 'exp_2025';
  IF c = 0 THEN
    ALTER TABLE `projects`
      ADD COLUMN `exp_2025` DECIMAL(14,2) NULL;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND column_name = 'budget_2026';
  IF c = 0 THEN
    ALTER TABLE `projects`
      ADD COLUMN `budget_2026` DECIMAL(14,2) NULL;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND column_name = 'exp_2026';
  IF c = 0 THEN
    ALTER TABLE `projects`
      ADD COLUMN `exp_2026` DECIMAL(14,2) NULL;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND column_name = 'in_2026';
  IF c = 0 THEN
    ALTER TABLE `projects`
      ADD COLUMN `in_2026` ENUM('YES','NO') NULL;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND column_name = 'budget_2026_simulation';
  IF c = 0 THEN
    ALTER TABLE `projects`
      ADD COLUMN `budget_2026_simulation` DECIMAL(14,2) NULL;
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_anaplan_2026`();
DROP PROCEDURE `__prms_apply_anaplan_2026`;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1776800000000, 'AddAnaplan2026ProjectFields1776800000000');


-- ============================================================================
-- Section 6 — DropResultsColumnFromProjects1776900000000
--   Drops `projects.results` only if it still exists.
-- ============================================================================

DROP PROCEDURE IF EXISTS `__prms_apply_drop_results`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_drop_results`()
BEGIN
  DECLARE c INT DEFAULT 0;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND column_name = 'results';
  IF c = 1 THEN
    ALTER TABLE `projects` DROP COLUMN `results`;
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_drop_results`();
DROP PROCEDURE `__prms_apply_drop_results`;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1776900000000, 'DropResultsColumnFromProjects1776900000000');


-- ============================================================================
-- Section 7 — AddIsGlobalToProjects1777000000000
-- ============================================================================

DROP PROCEDURE IF EXISTS `__prms_apply_is_global`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_is_global`()
BEGIN
  DECLARE c INT DEFAULT 0;

  SELECT COUNT(*) INTO c FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'projects'
      AND column_name = 'is_global';
  IF c = 0 THEN
    ALTER TABLE `projects`
      ADD COLUMN `is_global` BOOLEAN NOT NULL DEFAULT FALSE
      AFTER `negotiation_locked`;
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_is_global`();
DROP PROCEDURE `__prms_apply_is_global`;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1777000000000, 'AddIsGlobalToProjects1777000000000');


-- ============================================================================
-- Section 8 — AddLockedAndRatingUpdatedEventTypes1778000000000
-- ============================================================================

ALTER TABLE `mapping_negotiations`
  MODIFY COLUMN `event_type`
  ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started','removal_requested','removal_declined','locked','rating_updated')
  NOT NULL;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1778000000000, 'AddLockedAndRatingUpdatedEventTypes1778000000000');


-- ============================================================================
-- Section 9 — AddUserCentersTable1779000000000
-- ============================================================================

CREATE TABLE IF NOT EXISTS `user_centers` (
  `user_id`    INT         NOT NULL,
  `center_id`  INT         NOT NULL,
  `sort_order` INT         NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`user_id`, `center_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP PROCEDURE IF EXISTS `__prms_apply_user_centers`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_user_centers`()
BEGIN
  DECLARE c INT DEFAULT 0;

  SELECT COUNT(*) INTO c FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'user_centers'
      AND index_name = 'idx_user_centers_center_id';
  IF c = 0 THEN
    CREATE INDEX `idx_user_centers_center_id` ON `user_centers` (`center_id`);
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'user_centers'
      AND index_name = 'idx_user_centers_user_sort';
  IF c = 0 THEN
    CREATE INDEX `idx_user_centers_user_sort` ON `user_centers` (`user_id`, `sort_order`);
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'user_centers'
      AND constraint_name = 'FK_user_centers_user';
  IF c = 0 THEN
    ALTER TABLE `user_centers`
      ADD CONSTRAINT `FK_user_centers_user`
      FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'user_centers'
      AND constraint_name = 'FK_user_centers_center';
  IF c = 0 THEN
    ALTER TABLE `user_centers`
      ADD CONSTRAINT `FK_user_centers_center`
      FOREIGN KEY (`center_id`) REFERENCES `centers`(`id`)
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_user_centers`();
DROP PROCEDURE `__prms_apply_user_centers`;

INSERT IGNORE INTO `user_centers` (`user_id`, `center_id`, `sort_order`)
SELECT `id`, `center_id`, 0
FROM `users`
WHERE `center_id` IS NOT NULL;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1779000000000, 'AddUserCentersTable1779000000000');


-- ============================================================================
-- Section 10 — AddTocTables1779193380352
-- ============================================================================

CREATE TABLE IF NOT EXISTS `toc_aows` (
  `id`               int          NOT NULL AUTO_INCREMENT,
  `created_at`       datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`       datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `node_id`          varchar(36)  NOT NULL,
  `clarisa_toc_id`   varchar(36)  NULL,
  `acronym`          varchar(50)  NULL,
  `wp_official_code` varchar(100) NULL,
  `name`             varchar(255) NULL,
  `program_id`       int          NOT NULL,
  `synced_at`        datetime     NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `UQ_toc_aows_program_node` (`program_id`, `node_id`),
  INDEX `IDX_toc_aows_program` (`program_id`),
  CONSTRAINT `FK_toc_aows_program` FOREIGN KEY (`program_id`)
    REFERENCES `programs` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `toc_outputs` (
  `id`              int          NOT NULL AUTO_INCREMENT,
  `created_at`      datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`      datetime(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `node_id`         varchar(36)  NOT NULL,
  `title`           varchar(500) NULL,
  `description`     text         NULL,
  `type_of_output`  varchar(100) NULL,
  `related_node_id` varchar(36)  NULL,
  `aow_id`          int          NULL,
  `program_id`      int          NOT NULL,
  `synced_at`       datetime     NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `UQ_toc_outputs_program_node` (`program_id`, `node_id`),
  INDEX `IDX_toc_outputs_program` (`program_id`),
  INDEX `IDX_toc_outputs_aow` (`aow_id`),
  CONSTRAINT `FK_toc_outputs_program` FOREIGN KEY (`program_id`)
    REFERENCES `programs` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT `FK_toc_outputs_aow` FOREIGN KEY (`aow_id`)
    REFERENCES `toc_aows` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `toc_outcomes` (
  `id`              int                              NOT NULL AUTO_INCREMENT,
  `created_at`      datetime(6)                      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`      datetime(6)                      NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `node_id`         varchar(36)                      NOT NULL,
  `title`           varchar(500)                     NULL,
  `description`     text                             NULL,
  `outcome_type`    enum('intermediate','portfolio') NOT NULL,
  `related_node_id` varchar(36)                      NULL,
  `aow_id`          int                              NULL,
  `program_id`      int                              NOT NULL,
  `synced_at`       datetime                         NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `UQ_toc_outcomes_program_node` (`program_id`, `node_id`),
  INDEX `IDX_toc_outcomes_program` (`program_id`),
  INDEX `IDX_toc_outcomes_aow` (`aow_id`),
  CONSTRAINT `FK_toc_outcomes_program` FOREIGN KEY (`program_id`)
    REFERENCES `programs` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT `FK_toc_outcomes_aow` FOREIGN KEY (`aow_id`)
    REFERENCES `toc_aows` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1779193380352, 'AddTocTables1779193380352');


-- ============================================================================
-- Section 11 — AddSystemSettings1780000000000
-- ============================================================================

CREATE TABLE IF NOT EXISTS `system_settings` (
  `id`               TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `email_enabled`    TINYINT(1)       NOT NULL DEFAULT 0,
  `deadline_enabled` TINYINT(1)       NOT NULL DEFAULT 0,
  `deadline_date`    DATE             NULL,
  `updated_at`       DATETIME(6)      NOT NULL
                                       DEFAULT CURRENT_TIMESTAMP(6)
                                       ON UPDATE CURRENT_TIMESTAMP(6),
  `updated_by`       INT              NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `CHK_system_settings_singleton` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP PROCEDURE IF EXISTS `__prms_apply_system_settings`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_system_settings`()
BEGIN
  DECLARE c INT DEFAULT 0;
  SELECT COUNT(*) INTO c FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'system_settings'
      AND constraint_name = 'FK_system_settings_updated_by';
  IF c = 0 THEN
    ALTER TABLE `system_settings`
      ADD CONSTRAINT `FK_system_settings_updated_by`
      FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`)
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_system_settings`();
DROP PROCEDURE `__prms_apply_system_settings`;

INSERT IGNORE INTO `system_settings` (
  `id`, `email_enabled`, `deadline_enabled`, `deadline_date`, `updated_by`
) VALUES (
  1, 0, 0, NULL, NULL
);

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1780000000000, 'AddSystemSettings1780000000000');


-- ============================================================================
-- Section 12 — AddEmailsTable1781000000000
-- ============================================================================

CREATE TABLE IF NOT EXISTS `emails` (
  `id`                 BIGINT UNSIGNED                          NOT NULL AUTO_INCREMENT,
  `to_user_id`         INT                                      NULL,
  `to_email`           VARCHAR(320)                             NOT NULL,
  `subject`            VARCHAR(500)                             NOT NULL,
  `body`               MEDIUMTEXT                               NOT NULL,
  `body_format`        ENUM('text','html')                      NOT NULL DEFAULT 'html',
  `status`             ENUM('queued','sending','sent','failed') NOT NULL DEFAULT 'queued',
  `priority`           TINYINT UNSIGNED                         NOT NULL DEFAULT 5,
  `attempts`           INT UNSIGNED                             NOT NULL DEFAULT 0,
  `max_attempts`       INT UNSIGNED                             NOT NULL DEFAULT 5,
  `last_error`         TEXT                                     NULL,
  `locked_at`          DATETIME(6)                              NULL,
  `locked_by`          VARCHAR(100)                             NULL,
  `next_attempt_at`    DATETIME(6)                              NULL,
  `sent_at`            DATETIME(6)                              NULL,
  `queued_at`          DATETIME(6)                              NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `created_by_user_id` INT                                      NULL,
  `template_key`       VARCHAR(100)                             NULL,
  `metadata`           JSON                                     NULL,
  `created_at`         DATETIME(6)                              NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at`         DATETIME(6)                              NOT NULL
                                                                  DEFAULT CURRENT_TIMESTAMP(6)
                                                                  ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  INDEX `IDX_emails_status_next_attempt` (`status`, `next_attempt_at`),
  INDEX `IDX_emails_to_user_id` (`to_user_id`),
  INDEX `IDX_emails_queued_at` (`queued_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP PROCEDURE IF EXISTS `__prms_apply_emails`;
DELIMITER $$
CREATE PROCEDURE `__prms_apply_emails`()
BEGIN
  DECLARE c INT DEFAULT 0;

  SELECT COUNT(*) INTO c FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'emails'
      AND constraint_name = 'FK_emails_to_user';
  IF c = 0 THEN
    ALTER TABLE `emails`
      ADD CONSTRAINT `FK_emails_to_user`
      FOREIGN KEY (`to_user_id`) REFERENCES `users`(`id`)
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  SELECT COUNT(*) INTO c FROM information_schema.table_constraints
    WHERE table_schema = DATABASE() AND table_name = 'emails'
      AND constraint_name = 'FK_emails_created_by_user';
  IF c = 0 THEN
    ALTER TABLE `emails`
      ADD CONSTRAINT `FK_emails_created_by_user`
      FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`)
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$
DELIMITER ;

CALL `__prms_apply_emails`();
DROP PROCEDURE `__prms_apply_emails`;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1781000000000, 'AddEmailsTable1781000000000');


-- ============================================================================
-- Section 13 — AddProjectImplementationCountries1782000000000
-- ============================================================================

CREATE TABLE IF NOT EXISTS `project_implementation_countries` (
  `project_id` int NOT NULL,
  `country_id` int NOT NULL,
  PRIMARY KEY (`project_id`, `country_id`),
  KEY `IDX_project_impl_countries_project_id` (`project_id`),
  KEY `IDX_project_impl_countries_country_id` (`country_id`),
  CONSTRAINT `FK_project_impl_countries_project`
    FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `FK_project_impl_countries_country`
    FOREIGN KEY (`country_id`) REFERENCES `countries`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1782000000000, 'AddProjectImplementationCountries1782000000000');


-- ============================================================================
-- Post-deploy verification
-- ----------------------------------------------------------------------------
--   SELECT timestamp, name
--   FROM   migrations
--   WHERE  timestamp >= 1776400000000
--   ORDER  BY timestamp;
--
-- You should see 13 rows in ascending order, ending with
-- `1782000000000, AddProjectImplementationCountries1782000000000`.
-- ============================================================================
