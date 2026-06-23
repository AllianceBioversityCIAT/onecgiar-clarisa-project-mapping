import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a second, independent deadline to the `system_settings` singleton:
 * the **program** mapping deadline.
 *
 * Context: the existing `deadline_enabled` / `deadline_date` pair drives the
 * **center** mapping-progress reminders (renamed in the UI to "Center
 * Deadline notification"). Programs respond on a later timeline, so they get
 * their own deadline that drives the new program-start reminder emails.
 *
 *  - `program_deadline_enabled` — whether the program deadline is active.
 *  - `program_deadline_date`    — the date itself (DATE, nullable when the
 *                                 toggle is off). Same column type as
 *                                 `deadline_date`; the entity normalises it
 *                                 to a `YYYY-MM-DD` string to dodge timezone
 *                                 drift.
 *
 * Both columns are added with safe defaults (disabled / null) so the seeded
 * singleton row stays valid without a data backfill.
 *
 * `down()` drops both columns.
 */
export class AddProgramDeadlineSettings1793000000000 implements MigrationInterface {
  name = 'AddProgramDeadlineSettings1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`system_settings\`
        ADD COLUMN \`program_deadline_enabled\` TINYINT(1) NOT NULL DEFAULT 0
          AFTER \`deadline_date\`,
        ADD COLUMN \`program_deadline_date\` DATE NULL
          AFTER \`program_deadline_enabled\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`system_settings\`
        DROP COLUMN \`program_deadline_date\`,
        DROP COLUMN \`program_deadline_enabled\`
    `);
  }
}
