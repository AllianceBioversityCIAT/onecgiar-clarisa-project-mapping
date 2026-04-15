import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a project-level `negotiation_locked` flag to the `projects` table.
 *
 * This flag decouples the lock state of a project's negotiation from any
 * particular mapping's status enum. When `negotiation_locked = 1`, no
 * further mapping changes (proposals, counter-proposals, agreements)
 * may be made for that project.
 *
 * Safe for existing rows — the column defaults to 0 (unlocked) so the
 * current workflow continues unchanged until a toggle is wired in.
 */
export class AddNegotiationLockedToProjects1776182938174 implements MigrationInterface {
  name = 'AddNegotiationLockedToProjects1776182938174';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`projects\` ADD \`negotiation_locked\` tinyint(1) NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`projects\` DROP COLUMN \`negotiation_locked\``,
    );
  }
}
