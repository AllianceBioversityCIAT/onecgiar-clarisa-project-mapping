import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens `mapping_negotiations.event_type` to accept `locked` and
 * `rating_updated`.
 *
 * Closes three audit-trail gaps in the negotiation workflow:
 *  - Project lock now emits one `locked` event per active mapping so the
 *    consolidated timeline shows the round being sealed.
 *  - Inline allocation edits that only change ratings now emit a
 *    `rating_updated` event so the center's qualitative scoring history
 *    is visible alongside allocation moves.
 *  - The single-mapping `openNegotiation` path reuses the existing
 *    `negotiation_started` event type for consistency with the bulk
 *    start-negotiation flow (no enum change for that one).
 *
 * Full canonical set comes from prior migrations; we hand-list every
 * existing value plus the two new ones.
 */
export class AddLockedAndRatingUpdatedEventTypes1778000000000 implements MigrationInterface {
  name = 'AddLockedAndRatingUpdatedEventTypes1778000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started','removal_requested','removal_declined','locked','rating_updated')
        NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop dependent rows first so the narrowed enum doesn't reject them.
    await queryRunner.query(
      `DELETE FROM \`mapping_negotiations\` WHERE \`event_type\` IN ('locked','rating_updated')`,
    );
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started','removal_requested','removal_declined')
        NOT NULL
    `);
  }
}
