import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens the `mapping_negotiations` audit table so:
 *
 * 1. `event_type` accepts `flagged_for_assistance` — written immediately
 *    after the second program-rep counter-proposal trips the mapping's
 *    `needs_assistance` flag. The flag itself lives on the mapping row;
 *    this audit event is what shows up in the consolidated stream.
 *
 * 2. `actor_role` accepts `admin` and `workflow_admin` — historically
 *    admin actions were collapsed into `center_rep` for audit. With the
 *    introduction of the workflow_admin role we now record the actor's
 *    real role going forward. Existing rows are NOT backfilled.
 *
 * Down migration reverts both changes; the down on `event_type` deletes
 * any `flagged_for_assistance` rows first to avoid violating the
 * narrowed enum, and the down on `actor_role` likewise removes any
 * admin/workflow_admin rows so the column can be narrowed cleanly.
 */
export class AddFlaggedForAssistanceAndWidenActorRole1776200200000 implements MigrationInterface {
  name = 'AddFlaggedForAssistanceAndWidenActorRole1776200200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance')
        NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`actor_role\`
        ENUM('center_rep','program_rep','admin','workflow_admin')
        NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Narrow event_type back: drop any flagged_for_assistance rows first.
    await queryRunner.query(
      `DELETE FROM \`mapping_negotiations\` WHERE \`event_type\` = 'flagged_for_assistance'`,
    );
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed')
        NOT NULL
    `);

    // Narrow actor_role back: drop any admin / workflow_admin events first.
    await queryRunner.query(
      `DELETE FROM \`mapping_negotiations\` WHERE \`actor_role\` IN ('admin','workflow_admin')`,
    );
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`actor_role\`
        ENUM('center_rep','program_rep')
        NOT NULL
    `);
  }
}
