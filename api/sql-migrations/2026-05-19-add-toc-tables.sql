-- ============================================================================
-- TOC sync schema — production deployment
-- ----------------------------------------------------------------------------
-- Migration  : AddTocTables1779193380352
-- File       : api/src/database/migrations/1779193380352-AddTocTables.ts
-- Purpose    : Adds three new tables used by the MEL TOC sync module:
--                * toc_aows      — Areas of Work (one row per AOW per program)
--                * toc_outcomes  — TOC Outcomes (intermediate + portfolio)
--                * toc_outputs   — TOC Outputs (HLOs)
-- Idempotency: All CREATEs use IF NOT EXISTS. Safe to re-run if a partial
--              earlier attempt landed any of the three tables.
-- TypeORM    : Final INSERT records the migration in the `migrations` table
--              so `npm run migration:run` will skip it cleanly afterwards.
-- ============================================================================

START TRANSACTION;

-- ────────────────────────────────────────────────────────────────────────────
-- toc_aows — Areas of Work
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `toc_aows` (
  `id` int NOT NULL AUTO_INCREMENT,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `node_id` varchar(36) NOT NULL,
  `clarisa_toc_id` varchar(36) NULL,
  `acronym` varchar(50) NULL,
  `wp_official_code` varchar(100) NULL,
  `name` varchar(255) NULL,
  `program_id` int NOT NULL,
  `synced_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `UQ_toc_aows_program_node` (`program_id`, `node_id`),
  INDEX `IDX_toc_aows_program` (`program_id`),
  CONSTRAINT `FK_toc_aows_program` FOREIGN KEY (`program_id`)
    REFERENCES `programs` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ────────────────────────────────────────────────────────────────────────────
-- toc_outputs — High Level Outputs (HLOs)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `toc_outputs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `node_id` varchar(36) NOT NULL,
  `title` varchar(500) NULL,
  `description` text NULL,
  `type_of_output` varchar(100) NULL,
  `related_node_id` varchar(36) NULL,
  `aow_id` int NULL,
  `program_id` int NOT NULL,
  `synced_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `UQ_toc_outputs_program_node` (`program_id`, `node_id`),
  INDEX `IDX_toc_outputs_program` (`program_id`),
  INDEX `IDX_toc_outputs_aow` (`aow_id`),
  CONSTRAINT `FK_toc_outputs_program` FOREIGN KEY (`program_id`)
    REFERENCES `programs` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT `FK_toc_outputs_aow` FOREIGN KEY (`aow_id`)
    REFERENCES `toc_aows` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ────────────────────────────────────────────────────────────────────────────
-- toc_outcomes — TOC Outcomes (intermediate + portfolio)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `toc_outcomes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `node_id` varchar(36) NOT NULL,
  `title` varchar(500) NULL,
  `description` text NULL,
  `outcome_type` enum('intermediate','portfolio') NOT NULL,
  `related_node_id` varchar(36) NULL,
  `aow_id` int NULL,
  `program_id` int NOT NULL,
  `synced_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `UQ_toc_outcomes_program_node` (`program_id`, `node_id`),
  INDEX `IDX_toc_outcomes_program` (`program_id`),
  INDEX `IDX_toc_outcomes_aow` (`aow_id`),
  CONSTRAINT `FK_toc_outcomes_program` FOREIGN KEY (`program_id`)
    REFERENCES `programs` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT `FK_toc_outcomes_aow` FOREIGN KEY (`aow_id`)
    REFERENCES `toc_aows` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ────────────────────────────────────────────────────────────────────────────
-- Record migration so TypeORM's `migration:run` skips this one in the future
-- ────────────────────────────────────────────────────────────────────────────
INSERT IGNORE INTO `migrations` (`timestamp`, `name`)
VALUES (1779193380352, 'AddTocTables1779193380352');

COMMIT;

-- ============================================================================
-- After running this script:
--   1. Hit POST /admin/sync-toc as an admin user to populate the tables
--      from https://toc.mel.cgiar.org/api/toc/{program_official_code}
--   2. Or, restart the API — if all three tables are empty, the bootstrap
--      hook auto-runs the sync on startup.
-- ============================================================================
