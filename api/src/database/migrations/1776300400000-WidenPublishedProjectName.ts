import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens `published_projects.name` from `varchar(255)` to `varchar(1000)`.
 *
 * Discovered during Task #4 QA: 13 active projects have names longer
 * than 255 characters (max observed = 504), so any attempt to publish
 * a snapshot fails with "Data too long for column 'name'". This bug
 * predates Task #4 — fixing it here so the unit_admin snapshot flow
 * (Task #4) is shippable.
 *
 * Down: reverts to varchar(255) only if no row would be truncated.
 * Aborts otherwise so the rollback can never silently lose data.
 */
export class WidenPublishedProjectName1776300400000
  implements MigrationInterface
{
  name = 'WidenPublishedProjectName1776300400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`published_projects\`
        MODIFY COLUMN \`name\` VARCHAR(1000) NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*) AS count FROM \`published_projects\` WHERE LENGTH(\`name\`) > 255`,
    );
    const count = Number(rows?.[0]?.count ?? 0);
    if (count > 0) {
      throw new Error(
        `Cannot revert WidenPublishedProjectName: ${count} published project(s) have names longer than 255 characters and would be truncated.`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE \`published_projects\`
        MODIFY COLUMN \`name\` VARCHAR(255) NOT NULL
    `);
  }
}
