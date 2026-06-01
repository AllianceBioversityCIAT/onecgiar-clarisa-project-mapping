import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `user_programs` junction table, which lets a user (specifically
 * a program_rep) belong to multiple programs while preserving a user-selected
 * order.
 *
 * Design notes:
 *  - `users.program_id` is preserved as the *primary/default* program. It is
 *    NOT dropped by this migration. Going forward the row in `user_programs`
 *    with `sort_order = 0` is the primary and must mirror `users.program_id`.
 *  - Composite PK (user_id, program_id) prevents duplicate memberships per
 *    user and gives a covering index for "programs I belong to" lookups.
 *  - `idx_user_programs_program_id` supports the reverse lookup ("users in
 *    program X").
 *  - `idx_user_programs_user_sort` supports ordered fetches of a user's
 *    programs (primary first, then user-selected order).
 *  - Both FKs CASCADE on delete: removing a user or program cleans up
 *    membership rows automatically. (`users.program_id` already uses
 *    SET NULL semantics, so the two layers remain consistent: the user
 *    survives a program deletion with a NULL primary and zero membership
 *    rows in this table.)
 *  - Backfill seeds one row per user whose `users.program_id` is non-null,
 *    at `sort_order = 0`, so existing single-program users keep working
 *    without any service-layer changes.
 */
export class AddUserProgramsTable1788000000000 implements MigrationInterface {
  name = 'AddUserProgramsTable1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create the user_programs junction table.
    //    Charset/collation match `users` and `programs` (utf8mb4_0900_ai_ci)
    //    so FK creation does not fail on collation mismatch.
    await queryRunner.query(`
      CREATE TABLE \`user_programs\` (
        \`user_id\`     INT      NOT NULL,
        \`program_id\`  INT      NOT NULL,
        \`sort_order\`  INT      NOT NULL DEFAULT 0,
        \`created_at\`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`user_id\`, \`program_id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 2. Supporting indexes.
    //    - program_id index for "users in this program" reverse lookups.
    //    - (user_id, sort_order) index for ordered fetches of a user's
    //      programs (primary first via sort_order = 0).
    await queryRunner.query(`
      CREATE INDEX \`idx_user_programs_program_id\`
        ON \`user_programs\` (\`program_id\`)
    `);

    await queryRunner.query(`
      CREATE INDEX \`idx_user_programs_user_sort\`
        ON \`user_programs\` (\`user_id\`, \`sort_order\`)
    `);

    // 3. Foreign keys. CASCADE on delete for both: removing a user or
    //    program should clean up membership rows.
    await queryRunner.query(`
      ALTER TABLE \`user_programs\`
        ADD CONSTRAINT \`FK_user_programs_user\`
        FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
        ON DELETE CASCADE ON UPDATE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE \`user_programs\`
        ADD CONSTRAINT \`FK_user_programs_program\`
        FOREIGN KEY (\`program_id\`) REFERENCES \`programs\`(\`id\`)
        ON DELETE CASCADE ON UPDATE CASCADE
    `);

    // 4. Backfill: seed the junction table from the existing one-to-one
    //    `users.program_id` column. Every existing user with a program
    //    becomes a single-program membership at sort_order = 0 (primary).
    //    No ON DUPLICATE KEY needed — this is a brand new table.
    await queryRunner.query(`
      INSERT INTO \`user_programs\` (\`user_id\`, \`program_id\`, \`sort_order\`)
      SELECT \`id\`, \`program_id\`, 0
      FROM \`users\`
      WHERE \`program_id\` IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign keys before dropping the table (MySQL requires this).
    await queryRunner.query(`
      ALTER TABLE \`user_programs\` DROP FOREIGN KEY \`FK_user_programs_program\`
    `);

    await queryRunner.query(`
      ALTER TABLE \`user_programs\` DROP FOREIGN KEY \`FK_user_programs_user\`
    `);

    // Indexes are dropped implicitly with the table.
    // NOTE: `users.program_id` is intentionally untouched — it existed
    // before this migration and must survive a revert.
    await queryRunner.query(`DROP TABLE \`user_programs\``);
  }
}
