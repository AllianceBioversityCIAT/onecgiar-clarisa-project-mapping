import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `workflow_admin` to the `users.role` enum.
 *
 * The workflow admin is a system-office arbiter who has full negotiation
 * rights on every project regardless of center, without being able to
 * perform admin-only data operations (CSV import, CLARISA sync, project
 * CRUD, user management).
 *
 * Down: reverts to the original three-value enum. Safe only as long as
 * no rows currently use `workflow_admin` — the rollback would otherwise
 * truncate those values to '' which MySQL rejects under STRICT mode.
 */
export class AddWorkflowAdminRole1776200000000 implements MigrationInterface {
  name = 'AddWorkflowAdminRole1776200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`users\`
        MODIFY COLUMN \`role\` ENUM('admin','program_rep','center_rep','workflow_admin') NULL DEFAULT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Fail loudly if any rows still hold the new value — silently dropping
    // them would corrupt access for the workflow_admin user.
    const rows: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*) AS count FROM \`users\` WHERE \`role\` = 'workflow_admin'`,
    );
    const count = Number(rows?.[0]?.count ?? 0);
    if (count > 0) {
      throw new Error(
        `Cannot revert AddWorkflowAdminRole: ${count} user(s) still have role='workflow_admin'. ` +
          `Reassign or deactivate them before rolling back.`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE \`users\`
        MODIFY COLUMN \`role\` ENUM('admin','program_rep','center_rep') NULL DEFAULT NULL
    `);
  }
}
