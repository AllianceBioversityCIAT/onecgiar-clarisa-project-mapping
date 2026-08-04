import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `details` JSON to `published_projects`.
 *
 * The published payload was frozen before the negotiation redesign and has
 * since fallen behind the project model (no summary, no global flags, no
 * Country of Implementation, no TOC contribution). Rather than bolt on one
 * scalar column per field — none of which the snapshot query surface ever
 * filters or sorts on — everything new goes into a single JSON blob, so
 * future payload additions cost zero migrations.
 *
 * Nullable with no backfill: snapshots published before this migration
 * genuinely have no details, and back-filling them would fabricate history
 * from live data the snapshot deliberately froze away from.
 *
 * TOC contribution and the per-mapping extras (`programId`, `status`,
 * `allocatedBudget`) ride inside the existing `mappings` JSON column and
 * need no DDL — older rows simply lack those keys.
 *
 * Down: drops the column only while no snapshot has been published with
 * details, mirroring the guard on `WidenPublishedProjectName`. Snapshots
 * are immutable artifacts — re-running `up()` cannot restore a dropped
 * `details`, and republishing produces a different artifact from newer
 * live data, so a silent rollback would destroy history for good.
 */
export class AddDetailsToPublishedProjects1798000000000 implements MigrationInterface {
  name = 'AddDetailsToPublishedProjects1798000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`published_projects\`
        ADD COLUMN \`details\` JSON NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ count: string }> = await queryRunner.query(
      `SELECT COUNT(*) AS count FROM \`published_projects\` WHERE \`details\` IS NOT NULL`,
    );
    const count = Number(rows?.[0]?.count ?? 0);
    if (count > 0) {
      throw new Error(
        `Cannot revert AddDetailsToPublishedProjects: ${count} published project(s) carry details that would be lost. Snapshots are immutable — back up published_projects before forcing this revert.`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE \`published_projects\`
        DROP COLUMN \`details\`
    `);
  }
}
