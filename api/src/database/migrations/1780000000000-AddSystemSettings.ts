import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `system_settings` singleton table that stores
 * application-wide flags managed by the admin Settings page.
 *
 * Design notes:
 *  - **Singleton enforced by CHECK constraint** — `id = 1` is the only
 *    valid primary-key value. MySQL 8.0.16+ enforces CHECK constraints,
 *    so any attempt to insert a second row fails at the database level.
 *  - `email_enabled` — placeholder flag for the (not-yet-built) email
 *    module. Stored only; nothing in the codebase consumes it yet.
 *  - `deadline_enabled` + `deadline_date` — soft deadline by which the
 *    center reps must complete mapping. Not enforced anywhere yet, just
 *    read by the UI.
 *  - `updated_at` uses `ON UPDATE CURRENT_TIMESTAMP(6)` so we never have
 *    to set it manually in the service.
 *  - `updated_by` is `ON DELETE SET NULL` so deleting a user does not
 *    destroy the singleton row; the audit trail simply forgets who
 *    last touched it.
 *  - The singleton row is seeded in `up()` (both toggles off, date null,
 *    updated_by null) so `GET /settings` always finds it.
 *  - `down()` drops the whole table.
 */
export class AddSystemSettings1780000000000 implements MigrationInterface {
  name = 'AddSystemSettings1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create the singleton table. The CHECK (id = 1) constraint
    //    guarantees only a single row can ever exist.
    await queryRunner.query(`
      CREATE TABLE \`system_settings\` (
        \`id\`               TINYINT UNSIGNED NOT NULL DEFAULT 1,
        \`email_enabled\`    TINYINT(1)       NOT NULL DEFAULT 0,
        \`deadline_enabled\` TINYINT(1)       NOT NULL DEFAULT 0,
        \`deadline_date\`    DATE             NULL,
        \`updated_at\`       DATETIME(6)      NOT NULL
                                              DEFAULT CURRENT_TIMESTAMP(6)
                                              ON UPDATE CURRENT_TIMESTAMP(6),
        \`updated_by\`       INT              NULL,
        PRIMARY KEY (\`id\`),
        CONSTRAINT \`CHK_system_settings_singleton\` CHECK (\`id\` = 1)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    // 2. Foreign key for the actor who last touched the settings. The
    //    SET NULL behaviour means deleting a user does not break the
    //    singleton row — we just lose the "last edited by" attribution.
    await queryRunner.query(`
      ALTER TABLE \`system_settings\`
        ADD CONSTRAINT \`FK_system_settings_updated_by\`
        FOREIGN KEY (\`updated_by\`) REFERENCES \`users\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);

    // 3. Seed the singleton row. Defaults: both toggles disabled,
    //    no deadline, no updater. `updated_at` is filled by the
    //    column default (CURRENT_TIMESTAMP(6)).
    await queryRunner.query(`
      INSERT INTO \`system_settings\` (
        \`id\`, \`email_enabled\`, \`deadline_enabled\`, \`deadline_date\`, \`updated_by\`
      ) VALUES (
        1, 0, 0, NULL, NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the FK explicitly first; MySQL requires this before the
    // referenced columns/table can disappear.
    await queryRunner.query(`
      ALTER TABLE \`system_settings\`
        DROP FOREIGN KEY \`FK_system_settings_updated_by\`
    `);

    await queryRunner.query(`DROP TABLE \`system_settings\``);
  }
}
