import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `unit_admin` to the `users.role` enum.
 *
 * The unit admin (PPU/PCU) edits a whitelisted set of project metadata
 * fields on any project regardless of negotiation lock state, and can
 * trigger published-snapshot republishes. They have no mapping or
 * user-management powers and cannot edit Anaplan-sourced fields.
 *
 * Down: reverts to the four-value enum. Aborts if any rows still hold
 * `unit_admin` — silently dropping them would lock the affected user
 * out of their role-gated pages.
 */
export class AddUnitAdminRole1776300000000 implements MigrationInterface {
  name = 'AddUnitAdminRole1776300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`users\`
        MODIFY COLUMN \`role\` ENUM('admin','program_rep','center_rep','workflow_admin','unit_admin') NULL DEFAULT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*) AS count FROM \`users\` WHERE \`role\` = 'unit_admin'`,
    );
    const count = Number(rows?.[0]?.count ?? 0);
    if (count > 0) {
      throw new Error(
        `Cannot revert AddUnitAdminRole: ${count} user(s) still have role='unit_admin'. ` +
          `Reassign or deactivate them before rolling back.`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE \`users\`
        MODIFY COLUMN \`role\` ENUM('admin','program_rep','center_rep','workflow_admin') NULL DEFAULT NULL
    `);
  }
}
