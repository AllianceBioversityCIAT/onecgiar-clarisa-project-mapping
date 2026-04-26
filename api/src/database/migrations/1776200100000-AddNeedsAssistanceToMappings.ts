import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the "needs assistance" flag to `project_mappings`.
 *
 * Set automatically when a program rep submits their 2nd counter-proposal
 * on the same mapping (signal: the parties are stuck and a workflow admin
 * should arbitrate). Cleared when both sides agree.
 *
 * `flagged_at` records when the flag was raised — handy for sorting the
 * workflow admin's queue chronologically.
 *
 * A composite `(project_id, needs_assistance)` index serves both the
 * `GET /projects/?needsAssistance=true` EXISTS subquery and the per-project
 * flagged-mapping count — a bare `needs_assistance` index has too low
 * cardinality for the optimizer to pick.
 */
export class AddNeedsAssistanceToMappings1776200100000 implements MigrationInterface {
  name = 'AddNeedsAssistanceToMappings1776200100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD COLUMN \`needs_assistance\` TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN \`flagged_at\` DATETIME NULL
    `);

    await queryRunner.query(`
      CREATE INDEX \`IDX_project_mappings_project_needs_assistance\`
        ON \`project_mappings\` (\`project_id\`, \`needs_assistance\`)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX \`IDX_project_mappings_project_needs_assistance\`
        ON \`project_mappings\`
    `);

    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        DROP COLUMN \`flagged_at\`,
        DROP COLUMN \`needs_assistance\`
    `);
  }
}
