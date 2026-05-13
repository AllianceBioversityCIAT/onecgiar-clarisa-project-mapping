import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the `results` column from the `projects` table.
 *
 * The field captured "key results / expected outcomes" as free text but
 * is no longer surfaced anywhere in the registry — the project detail
 * view, list, export, and Anaplan-driven import all stopped writing or
 * reading it. Removing the column keeps the schema lean and prevents
 * stale free-text drift between Anaplan refreshes.
 *
 * Down re-creates the column with its original shape (`text NULL`) so
 * the migration is reversible if needed.
 */
export class DropResultsColumnFromProjects1776900000000 implements MigrationInterface {
  name = 'DropResultsColumnFromProjects1776900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        DROP COLUMN \`results\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD COLUMN \`results\` TEXT NULL AFTER \`summary\`
    `);
  }
}
