import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the workflow-admin "Final Decision" terminal state to the
 * negotiation surface:
 *
 *  - `project_mappings.status` gains `admin_decision` — the workflow admin's
 *    imposed, binding allocation (agreed-equivalent; the project is locked on
 *    the same action). The vestigial `locked` value is preserved in the enum
 *    list (it is unused since RetireMappingLockedStatus but never dropped).
 *  - `mapping_negotiations.event_type` gains `admin_decision` — one event per
 *    non-removed mapping recording the admin's final allocation + reason.
 *
 * MySQL's `MODIFY COLUMN ENUM(...)` requires the full value list, so each is
 * hand-listed with the new value appended.
 */
export class AddAdminDecisionStatusAndEvent1789000000000
  implements MigrationInterface
{
  name = 'AddAdminDecisionStatusAndEvent1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        MODIFY COLUMN \`status\`
        ENUM('draft','negotiating','agreed','locked','removed','admin_decision')
        NOT NULL DEFAULT 'draft'
    `);

    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started','removal_requested','removal_declined','locked','rating_updated','toc_updated','admin_decision')
        NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Demote admin-decision mappings to `agreed` (their agreed-equivalent
    // meaning) before narrowing the enum so no row is orphaned.
    await queryRunner.query(`
      UPDATE \`project_mappings\`
      SET \`status\` = 'agreed', \`center_agreed\` = 1, \`program_agreed\` = 1
      WHERE \`status\` = 'admin_decision'
    `);
    await queryRunner.query(
      `DELETE FROM \`mapping_negotiations\` WHERE \`event_type\` = 'admin_decision'`,
    );

    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        MODIFY COLUMN \`status\`
        ENUM('draft','negotiating','agreed','locked','removed')
        NOT NULL DEFAULT 'draft'
    `);
    await queryRunner.query(`
      ALTER TABLE \`mapping_negotiations\`
        MODIFY COLUMN \`event_type\`
        ENUM('initiated','counter_proposed','agreed','reopened','removed','flagged_for_assistance','negotiation_started','removal_requested','removal_declined','locked','rating_updated','toc_updated')
        NOT NULL
    `);
  }
}
