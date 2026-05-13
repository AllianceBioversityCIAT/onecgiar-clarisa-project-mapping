import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `created_by_role` to `published_snapshots` so we can distinguish
 * snapshots created by an admin vs a unit_admin (PPU/PCU). Historical
 * rows stay NULL — no backfill, since the column is nullable.
 *
 * The user who created the snapshot is already tracked via the
 * existing `published_by` FK; we only need the actor's role.
 */
export class AddCreatedByRoleToPublishedSnapshots1776300200000 implements MigrationInterface {
  name = 'AddCreatedByRoleToPublishedSnapshots1776300200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`published_snapshots\`
        ADD COLUMN \`created_by_role\` ENUM('admin','unit_admin') NULL DEFAULT NULL AFTER \`published_by\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`published_snapshots\`
        DROP COLUMN \`created_by_role\`
    `);
  }
}
