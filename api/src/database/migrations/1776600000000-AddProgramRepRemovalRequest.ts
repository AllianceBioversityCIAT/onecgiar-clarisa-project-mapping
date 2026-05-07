import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the program-rep removal-request workflow.
 *
 * A program rep can no longer remove their own mapping unilaterally — they
 * raise a request that the center side must accept or decline. The four
 * new columns track the pending request:
 *  - `removal_requested`        : flag indicating an unresolved request
 *  - `removal_requested_by`     : program rep who raised it
 *  - `removal_requested_at`     : when it was raised (for ordering / UI)
 *  - `removal_justification`    : program rep's stated reason (carried over
 *                                 to the eventual `removed` event when the
 *                                 center accepts)
 *
 * Two new event types are added to `mapping_negotiations.event_type`:
 *  - `removal_requested`  — program rep asks the center to remove the program
 *  - `removal_declined`   — center side rejects the request, mapping stays put
 *
 * The eventual acceptance still uses the existing `removed` event, so the
 * audit timeline reads naturally: requested → declined (or → removed).
 */
export class AddProgramRepRemovalRequest1776600000000 implements MigrationInterface {
  name = 'AddProgramRepRemovalRequest1776600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. New columns on project_mappings.
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD COLUMN \`removal_requested\` TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN \`removal_requested_by\` INT NULL,
        ADD COLUMN \`removal_requested_at\` DATETIME NULL,
        ADD COLUMN \`removal_justification\` TEXT NULL
    `);

    // FK so removal_requested_by behaves like other actor refs (RESTRICT
    // on user delete — we keep the audit trail even if a user is removed
    // from the system).
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD CONSTRAINT \`FK_project_mappings_removal_requested_by\`
        FOREIGN KEY (\`removal_requested_by\`) REFERENCES \`users\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);

    // Composite index — supports "find pending removal requests for a
    // project" lookups; the partial nature (request column TINYINT 0/1)
    // keeps cardinality high enough.
    await queryRunner.query(`
      CREATE INDEX \`IDX_project_mappings_project_removal_requested\`
        ON \`project_mappings\` (\`project_id\`, \`removal_requested\`)
    `);

    // 2. Widen the mapping_negotiations.event_type enum with the two new
    // values. Full canonical set comes from prior migrations; we hand-list
    // every existing value plus the new ones to avoid surprises.
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started','removal_requested','removal_declined')
        NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop dependent rows first so the narrowed enum doesn't reject them.
    await queryRunner.query(
      `DELETE FROM \`mapping_negotiations\` WHERE \`event_type\` IN ('removal_requested','removal_declined')`,
    );
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started')
        NOT NULL
    `);

    await queryRunner.query(`
      DROP INDEX \`IDX_project_mappings_project_removal_requested\`
        ON \`project_mappings\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        DROP FOREIGN KEY \`FK_project_mappings_removal_requested_by\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        DROP COLUMN \`removal_justification\`,
        DROP COLUMN \`removal_requested_at\`,
        DROP COLUMN \`removal_requested_by\`,
        DROP COLUMN \`removal_requested\`
    `);
  }
}
