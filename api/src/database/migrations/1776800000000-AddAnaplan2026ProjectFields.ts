import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the new columns sourced from the May-2026 revision of the
 * Anaplan 4.1 Project Info export (sheet `4.1-update5May26`):
 *
 *  - email                   Principal-investigator contact email.
 *  - exp_2025                Actual 2025 expenditure (USD).
 *  - budget_2026             Planned 2026 budget figure (USD).
 *  - exp_2026                Actual 2026 expenditure to date (USD).
 *  - in_2026                 Anaplan YES/NO flag — whether the project
 *                            is part of the 2026 portfolio.
 *  - budget_2026_simulation  Simulated / canonical 2026 budget. We
 *                            treat this column as the authoritative
 *                            `total_budget` source going forward, and
 *                            keep the original cell here for traceability.
 *
 * All columns are nullable so existing rows remain valid without a
 * backfill. Legacy Anaplan fields (`category`, `csp`, `csp_non_collection_reason`,
 * `status`) are left in place — the new template no longer feeds them
 * but the detail pages and exports still display historical values.
 *
 * Money columns use `decimal(14,2)` to match `total_pledge`, the existing
 * money convention for Anaplan-sourced amounts (separate from the smaller
 * `decimal(10,2)` allocation columns on the older `total_budget`).
 */
export class AddAnaplan2026ProjectFields1776800000000 implements MigrationInterface {
  name = 'AddAnaplan2026ProjectFields1776800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD COLUMN \`email\` VARCHAR(255) NULL AFTER \`principal_investigator\`,
        ADD COLUMN \`exp_2025\` DECIMAL(14,2) NULL AFTER \`email\`,
        ADD COLUMN \`budget_2026\` DECIMAL(14,2) NULL AFTER \`exp_2025\`,
        ADD COLUMN \`exp_2026\` DECIMAL(14,2) NULL AFTER \`budget_2026\`,
        ADD COLUMN \`in_2026\` ENUM('YES','NO') NULL AFTER \`exp_2026\`,
        ADD COLUMN \`budget_2026_simulation\` DECIMAL(14,2) NULL AFTER \`in_2026\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        DROP COLUMN \`budget_2026_simulation\`,
        DROP COLUMN \`in_2026\`,
        DROP COLUMN \`exp_2026\`,
        DROP COLUMN \`budget_2026\`,
        DROP COLUMN \`exp_2025\`,
        DROP COLUMN \`email\`
    `);
  }
}
