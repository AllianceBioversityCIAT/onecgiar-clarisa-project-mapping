import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the **program-side** "Notification of Updates" digest settings to the
 * `system_settings` singleton — the program twin of the center digest added
 * in `1794000000000-AddUpdateDigestSettings`.
 *
 * Context: the center digest (`update_digest_*`) tells a center which of its
 * projects saw activity. This parallel set drives the program digest, which
 * tells a program which projects (scoped to that program's mappings) saw
 * activity in the trailing window, with each project's current program-side
 * status. It runs independently of the center digest and the deadline flags,
 * and stops once `program_update_digest_end_date` has passed.
 *
 *  - `program_update_digest_enabled`       — master toggle for the cron.
 *  - `program_update_digest_interval_days` — minimum whole-days between digest
 *                                            sends (cadence throttle). Default 2.
 *  - `program_update_digest_window_days`   — trailing window (in days) over
 *                                            which a project counts as
 *                                            "updated". Default 2.
 *  - `program_update_digest_end_date`      — last date the digest sends (DATE,
 *                                            nullable when the toggle is off).
 *  - `program_update_digest_last_run_at`   — timestamp of the last digest run
 *                                            that actually iterated programs.
 *                                            Service-managed only (never set
 *                                            via PATCH); drives the
 *                                            interval/not-due check.
 *
 * All columns are added with safe defaults (disabled / sensible interval +
 * window / null dates) so the seeded singleton row stays valid without a
 * data backfill. Columns are positioned AFTER `update_digest_last_run_at`.
 *
 * `down()` drops the five columns (LIFO).
 */
export class AddProgramUpdateDigestSettings1795000000000
  implements MigrationInterface
{
  name = 'AddProgramUpdateDigestSettings1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`system_settings\`
        ADD COLUMN \`program_update_digest_enabled\` TINYINT(1) NOT NULL DEFAULT 0
          AFTER \`update_digest_last_run_at\`,
        ADD COLUMN \`program_update_digest_interval_days\` INT NOT NULL DEFAULT 2
          AFTER \`program_update_digest_enabled\`,
        ADD COLUMN \`program_update_digest_window_days\` INT NOT NULL DEFAULT 2
          AFTER \`program_update_digest_interval_days\`,
        ADD COLUMN \`program_update_digest_end_date\` DATE NULL
          AFTER \`program_update_digest_window_days\`,
        ADD COLUMN \`program_update_digest_last_run_at\` DATETIME(6) NULL
          AFTER \`program_update_digest_end_date\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`system_settings\`
        DROP COLUMN \`program_update_digest_last_run_at\`,
        DROP COLUMN \`program_update_digest_end_date\`,
        DROP COLUMN \`program_update_digest_window_days\`,
        DROP COLUMN \`program_update_digest_interval_days\`,
        DROP COLUMN \`program_update_digest_enabled\`
    `);
  }
}
