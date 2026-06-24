import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the "Notification of Updates" digest settings to the
 * `system_settings` singleton.
 *
 * Context: the existing center / program deadline reminders nudge reps
 * toward a deadline. This new digest is orthogonal — on a fixed cadence
 * it tells a center which of its projects saw activity (any
 * `mapping_negotiations` row, chat included) in the trailing window, with
 * each project's current center-side status. It runs independently of the
 * deadline flags and stops once `update_digest_end_date` has passed.
 *
 *  - `update_digest_enabled`       — master toggle for the digest cron.
 *  - `update_digest_interval_days` — minimum whole-days between digest
 *                                    sends (cadence throttle). Default 2.
 *  - `update_digest_window_days`   — trailing window (in days) over which a
 *                                    project counts as "updated". Default 2.
 *  - `update_digest_end_date`      — last date the digest sends (DATE,
 *                                    nullable when the toggle is off). Same
 *                                    column type as `deadline_date`; the
 *                                    entity normalises it to a `YYYY-MM-DD`
 *                                    string to dodge timezone drift.
 *  - `update_digest_last_run_at`   — timestamp of the last digest run that
 *                                    actually iterated centers. Service-
 *                                    managed only (never set via PATCH);
 *                                    drives the interval/not-due check.
 *
 * All columns are added with safe defaults (disabled / sensible interval +
 * window / null dates) so the seeded singleton row stays valid without a
 * data backfill.
 *
 * `down()` drops the five columns.
 */
export class AddUpdateDigestSettings1794000000000 implements MigrationInterface {
  name = 'AddUpdateDigestSettings1794000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`system_settings\`
        ADD COLUMN \`update_digest_enabled\` TINYINT(1) NOT NULL DEFAULT 0
          AFTER \`program_deadline_date\`,
        ADD COLUMN \`update_digest_interval_days\` INT NOT NULL DEFAULT 2
          AFTER \`update_digest_enabled\`,
        ADD COLUMN \`update_digest_window_days\` INT NOT NULL DEFAULT 2
          AFTER \`update_digest_interval_days\`,
        ADD COLUMN \`update_digest_end_date\` DATE NULL
          AFTER \`update_digest_window_days\`,
        ADD COLUMN \`update_digest_last_run_at\` DATETIME(6) NULL
          AFTER \`update_digest_end_date\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`system_settings\`
        DROP COLUMN \`update_digest_last_run_at\`,
        DROP COLUMN \`update_digest_end_date\`,
        DROP COLUMN \`update_digest_window_days\`,
        DROP COLUMN \`update_digest_interval_days\`,
        DROP COLUMN \`update_digest_enabled\`
    `);
  }
}
