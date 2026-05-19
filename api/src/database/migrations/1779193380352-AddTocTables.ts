import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the three tables backing the TOC (Theory of Change) sync
 * module — `toc_aows`, `toc_outcomes`, `toc_outputs`.
 *
 * All three tables FK to `programs.id` (`ON DELETE CASCADE`) so a
 * program removal cleans up its full TOC graph in one shot.
 * `toc_outputs` and `toc_outcomes` additionally FK to `toc_aows.id`
 * with `ON DELETE SET NULL` so dropping an AOW does not destroy the
 * rows that hang off it — they simply become unparented and can be
 * re-resolved on the next sync.
 *
 * Each table has a `(program_id, node_id)` unique composite index so
 * the sync service can upsert idempotently across re-runs without
 * needing to issue a delete-all-then-reinsert. `node_id` is computed
 * by the sync service as `related_node_id ?? id` from the TOC graph
 * node — see `TocSyncService.resolveNodeId`.
 *
 * Hand-written rather than generated: `migration:generate` on this
 * codebase emits a large amount of FK-rename drift against unrelated
 * tables (custom FK names vs. TypeORM's auto-generated hashes). The
 * three CREATE TABLE blocks below are the only changes needed.
 */
export class AddTocTables1779193380352 implements MigrationInterface {
  name = 'AddTocTables1779193380352';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── toc_aows ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE \`toc_aows\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`node_id\` varchar(36) NOT NULL,
        \`clarisa_toc_id\` varchar(36) NULL,
        \`acronym\` varchar(50) NULL,
        \`wp_official_code\` varchar(100) NULL,
        \`name\` varchar(255) NULL,
        \`program_id\` int NOT NULL,
        \`synced_at\` datetime NOT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`UQ_toc_aows_program_node\` (\`program_id\`, \`node_id\`),
        INDEX \`IDX_toc_aows_program\` (\`program_id\`),
        CONSTRAINT \`FK_toc_aows_program\` FOREIGN KEY (\`program_id\`)
          REFERENCES \`programs\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── toc_outputs ────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE \`toc_outputs\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`node_id\` varchar(36) NOT NULL,
        \`title\` varchar(500) NULL,
        \`description\` text NULL,
        \`type_of_output\` varchar(100) NULL,
        \`related_node_id\` varchar(36) NULL,
        \`aow_id\` int NULL,
        \`program_id\` int NOT NULL,
        \`synced_at\` datetime NOT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`UQ_toc_outputs_program_node\` (\`program_id\`, \`node_id\`),
        INDEX \`IDX_toc_outputs_program\` (\`program_id\`),
        INDEX \`IDX_toc_outputs_aow\` (\`aow_id\`),
        CONSTRAINT \`FK_toc_outputs_program\` FOREIGN KEY (\`program_id\`)
          REFERENCES \`programs\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT \`FK_toc_outputs_aow\` FOREIGN KEY (\`aow_id\`)
          REFERENCES \`toc_aows\` (\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // ── toc_outcomes ───────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE \`toc_outcomes\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`node_id\` varchar(36) NOT NULL,
        \`title\` varchar(500) NULL,
        \`description\` text NULL,
        \`outcome_type\` enum ('intermediate', 'portfolio') NOT NULL,
        \`related_node_id\` varchar(36) NULL,
        \`aow_id\` int NULL,
        \`program_id\` int NOT NULL,
        \`synced_at\` datetime NOT NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`UQ_toc_outcomes_program_node\` (\`program_id\`, \`node_id\`),
        INDEX \`IDX_toc_outcomes_program\` (\`program_id\`),
        INDEX \`IDX_toc_outcomes_aow\` (\`aow_id\`),
        CONSTRAINT \`FK_toc_outcomes_program\` FOREIGN KEY (\`program_id\`)
          REFERENCES \`programs\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT \`FK_toc_outcomes_aow\` FOREIGN KEY (\`aow_id\`)
          REFERENCES \`toc_aows\` (\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /* Drop child tables first so the FK back to toc_aows releases. */
    await queryRunner.query(`DROP TABLE \`toc_outcomes\``);
    await queryRunner.query(`DROP TABLE \`toc_outputs\``);
    await queryRunner.query(`DROP TABLE \`toc_aows\``);
  }
}
