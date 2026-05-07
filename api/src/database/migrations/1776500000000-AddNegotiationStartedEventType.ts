import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens `mapping_negotiations.event_type` to accept `negotiation_started`.
 *
 * Emitted when the center rep bulk-promotes draft mappings to `negotiating`
 * via `POST /mappings/projects/:projectId/start-negotiation`. Pairs with the
 * new reopen-as-draft flow: reopen sets every non-removed mapping back to
 * `draft` (invisible to program reps), and the start-negotiation endpoint
 * is what makes the round live again.
 *
 * MySQL enum mods can be flaky to auto-generate, so we hand-list every
 * existing value plus the new one. The full canonical set comes from
 * 1776200200000-AddFlaggedForAssistanceAndWidenActorRole.ts.
 *
 * Down migration narrows the enum back; any `negotiation_started` rows are
 * deleted first to avoid violating the narrower enum.
 */
export class AddNegotiationStartedEventType1776500000000 implements MigrationInterface {
  name = 'AddNegotiationStartedEventType1776500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started')
        NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop any negotiation_started rows so the narrower enum doesn't reject them.
    await queryRunner.query(
      `DELETE FROM \`mapping_negotiations\` WHERE \`event_type\` = 'negotiation_started'`,
    );
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance')
        NOT NULL
    `);
  }
}
