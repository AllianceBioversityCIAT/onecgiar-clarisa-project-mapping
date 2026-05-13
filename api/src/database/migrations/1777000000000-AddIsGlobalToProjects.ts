import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `is_global` boolean flag to the `projects` table.
 *
 * A "Global" project has no country-specific scope — it spans every
 * geography. The flag drives both UI (form hides the countries
 * selector) and the TOC importer (a `Location` column value of
 * "Global" maps to `is_global = true`).
 *
 * Schema choices:
 *  - `NOT NULL DEFAULT false` so every existing row is implicitly
 *    non-global immediately after the migration runs (no backfill
 *    step required).
 *  - The column sits after `negotiation_locked` to keep boolean
 *    flags grouped together for readability.
 *
 * Mutual-exclusion guarantee (is_global = true => empty
 * project_countries) is enforced at the service layer, not via a
 * DB-level trigger, to keep the schema change minimal and reversible.
 */
export class AddIsGlobalToProjects1777000000000 implements MigrationInterface {
  name = 'AddIsGlobalToProjects1777000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD COLUMN \`is_global\` BOOLEAN NOT NULL DEFAULT false
        AFTER \`negotiation_locked\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        DROP COLUMN \`is_global\`
    `);
  }
}
