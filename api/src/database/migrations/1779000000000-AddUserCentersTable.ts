import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `user_centers` junction table, which lets a user (specifically
 * a center_rep) belong to multiple centers while preserving a user-selected
 * order.
 *
 * Design notes:
 *  - `users.center_id` is preserved as the *primary/default* center. It is
 *    NOT dropped by this migration. Going forward the row in `user_centers`
 *    with `sort_order = 0` is the primary and must mirror `users.center_id`.
 *  - Composite PK (user_id, center_id) prevents duplicate memberships per
 *    user and gives a covering index for "centers I belong to" lookups.
 *  - `idx_user_centers_center_id` supports the reverse lookup ("users in
 *    center X").
 *  - `idx_user_centers_user_sort` supports ordered fetches of a user's
 *    centers (primary first, then user-selected order).
 *  - Both FKs CASCADE on delete: removing a user or center cleans up
 *    membership rows automatically. (`users.center_id` already uses
 *    SET NULL semantics, so the two layers remain consistent: the user
 *    survives a center deletion with a NULL primary and zero membership
 *    rows in this table.)
 *  - Backfill seeds one row per user whose `users.center_id` is non-null,
 *    at `sort_order = 0`, so existing single-center users keep working
 *    without any service-layer changes.
 */
export class AddUserCentersTable1779000000000 implements MigrationInterface {
  name = 'AddUserCentersTable1779000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create the user_centers junction table.
    //    Charset/collation match `users` and `centers` (utf8mb4_0900_ai_ci)
    //    so FK creation does not fail on collation mismatch.
    await queryRunner.query(`
      CREATE TABLE \`user_centers\` (
        \`user_id\`     INT      NOT NULL,
        \`center_id\`   INT      NOT NULL,
        \`sort_order\`  INT      NOT NULL DEFAULT 0,
        \`created_at\`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`user_id\`, \`center_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 2. Supporting indexes.
    //    - center_id index for "users in this center" reverse lookups.
    //    - (user_id, sort_order) index for ordered fetches of a user's
    //      centers (primary first via sort_order = 0).
    await queryRunner.query(`
      CREATE INDEX \`idx_user_centers_center_id\`
        ON \`user_centers\` (\`center_id\`)
    `);

    await queryRunner.query(`
      CREATE INDEX \`idx_user_centers_user_sort\`
        ON \`user_centers\` (\`user_id\`, \`sort_order\`)
    `);

    // 3. Foreign keys. CASCADE on delete for both: removing a user or
    //    center should clean up membership rows.
    await queryRunner.query(`
      ALTER TABLE \`user_centers\`
        ADD CONSTRAINT \`FK_user_centers_user\`
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
        ON DELETE CASCADE ON UPDATE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE \`user_centers\`
        ADD CONSTRAINT \`FK_user_centers_center\`
        FOREIGN KEY (\`center_id\`) REFERENCES \`centers\`(\`id\`)
        ON DELETE CASCADE ON UPDATE CASCADE
    `);

    // 4. Backfill: seed the junction table from the existing one-to-one
    //    `users.center_id` column. Every existing user with a center
    //    becomes a single-center membership at sort_order = 0 (primary).
    //    No ON DUPLICATE KEY needed — this is a brand new table.
    await queryRunner.query(`
      INSERT INTO \`user_centers\` (\`user_id\`, \`center_id\`, \`sort_order\`)
      SELECT \`id\`, \`center_id\`, 0
      FROM \`users\`
      WHERE \`center_id\` IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign keys before dropping the table (MySQL requires this).
    await queryRunner.query(`
      ALTER TABLE \`user_centers\` DROP FOREIGN KEY \`FK_user_centers_center\`
    `);

    await queryRunner.query(`
      ALTER TABLE \`user_centers\` DROP FOREIGN KEY \`FK_user_centers_user\`
    `);

    // Indexes are dropped implicitly with the table.
    // NOTE: `users.center_id` is intentionally untouched — it existed
    // before this migration and must survive a revert.
    await queryRunner.query(`DROP TABLE \`user_centers\``);
  }
}
