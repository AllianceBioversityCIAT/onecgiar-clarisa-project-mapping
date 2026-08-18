import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the annual mapping-session kill switch to the `system_settings`
 * singleton.
 *
 *  - `mapping_session_closed` — when `1`, the whole mapping/negotiation
 *    surface is frozen: center reps and program reps (and the workflow
 *    admin) can no longer create, edit, agree, counter-propose, remove,
 *    lock, reopen, chat or bulk-import mappings. Reads stay open, and the
 *    negotiation page shows the "session concluded" notice instead of the
 *    action controls.
 *
 * Defaults to `0` (session open) so the seeded singleton row stays valid
 * without a data backfill — closing the session is always an explicit
 * admin action from the Settings page.
 *
 * `down()` drops the column.
 */
export class AddMappingSessionClosedSetting1799000000000 implements MigrationInterface {
  name = 'AddMappingSessionClosedSetting1799000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`system_settings\`
        ADD COLUMN \`mapping_session_closed\` TINYINT(1) NOT NULL DEFAULT 0
          AFTER \`program_update_digest_last_run_at\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`system_settings\`
        DROP COLUMN \`mapping_session_closed\`
    `);
  }
}
