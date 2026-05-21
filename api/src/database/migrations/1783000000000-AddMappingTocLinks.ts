import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds TOC contribution-link support to project mappings.
 *
 * Two changes in one migration so the audit-event widening lands
 * atomically with the table that justifies it:
 *
 *  1. Widens `mapping_negotiations.event_type` to accept `toc_updated`.
 *     The full enum below is the canonical set as of the prior
 *     migration `AddLockedAndRatingUpdatedEventTypes` plus the new
 *     value. MySQL's `MODIFY COLUMN ENUM(...)` requires the entire
 *     enum to be re-stated.
 *
 *  2. Creates `mapping_toc_links` — a polymorphic junction table
 *     storing one row per (mapping, link_type, toc_id) pair.
 *     `link_type` discriminates which TOC table `toc_id` references
 *     (`toc_aows.id` / `toc_outputs.id` / `toc_outcomes.id`). No FK
 *     on `toc_id` because MySQL has no conditional foreign keys;
 *     `MappingsService.setTocLinks` enforces existence + program
 *     scope at the service layer with a single SELECT per type.
 *
 *     `created_by_user_id` is nullable so deleting a user via
 *     `ON DELETE SET NULL` does not destroy historic link rows
 *     (the user_id is a "who set this" pointer, not load-bearing).
 *     The FK on `project_mapping_id` is `ON DELETE CASCADE` so
 *     mapping removal cleans up its link rows in one shot.
 *
 *     Composite unique `(project_mapping_id, link_type, toc_id)`
 *     prevents duplicate links and doubles as the lookup index
 *     for hydration (leading column covers `WHERE project_mapping_id = ?`).
 */
export class AddMappingTocLinks1783000000000 implements MigrationInterface {
  name = 'AddMappingTocLinks1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Widen mapping_negotiations.event_type ──────────────────
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started','removal_requested','removal_declined','locked','rating_updated','toc_updated')
        NOT NULL
    `);

    // ── 2. Create mapping_toc_links ───────────────────────────────
    // Integer widths match the referenced PKs (project_mappings.id,
    // users.id, toc_*.id are all `int` post-ConvertPkToInt). MySQL
    // InnoDB rejects FKs across mismatched integer widths.
    await queryRunner.query(`
      CREATE TABLE \`mapping_toc_links\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`project_mapping_id\` int NOT NULL,
        \`link_type\` enum('aow','output','outcome') NOT NULL,
        \`toc_id\` int NOT NULL,
        \`created_by_user_id\` int NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`),
        UNIQUE INDEX \`UQ_mapping_toc_links_mapping_type_toc\`
          (\`project_mapping_id\`, \`link_type\`, \`toc_id\`),
        CONSTRAINT \`FK_mapping_toc_links_mapping\` FOREIGN KEY (\`project_mapping_id\`)
          REFERENCES \`project_mappings\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT \`FK_mapping_toc_links_user\` FOREIGN KEY (\`created_by_user_id\`)
          REFERENCES \`users\` (\`id\`) ON DELETE SET NULL ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the table first so its CASCADE FK detaches cleanly before
    // we narrow the enum (the table itself does not store the new
    // event_type value but its lifecycle is logically paired).
    await queryRunner.query(`DROP TABLE \`mapping_toc_links\``);

    // Delete dependent rows before narrowing the enum or MySQL will
    // refuse the MODIFY. Mirrors the pattern in
    // AddLockedAndRatingUpdatedEventTypes.
    await queryRunner.query(
      `DELETE FROM \`mapping_negotiations\` WHERE \`event_type\` = 'toc_updated'`,
    );
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started','removal_requested','removal_declined','locked','rating_updated')
        NOT NULL
    `);
  }
}
