import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts all primary keys and foreign keys in the schema from
 * UUID (`varchar(36)`) to auto-increment `int`.
 *
 * Rationale: this is a single-database, single-server application with a
 * small, bounded data volume. UUIDs add no value over auto-increment ints
 * in this environment (no distributed writes, no cross-shard merges) and
 * make debugging, logging, and URLs noisier than necessary.
 *
 * IMPORTANT — data loss:
 * This migration TRUNCATES every affected table. The client has confirmed
 * that no production data exists yet and that CLARISA sync + CSV import
 * can be re-run after migration to repopulate reference data and projects.
 *
 * High-level steps:
 *   1. Disable FK checks so we can freely drop/alter columns.
 *   2. Drop all FK constraints that depend on id columns we are changing.
 *   3. Drop the `project_countries` join table (will be recreated).
 *   4. For each PK table: truncate, drop id column, add new AUTO_INCREMENT id.
 *   5. For each FK column: change varchar(36) -> int (preserving nullability).
 *   6. Recreate the `project_countries` join table with int columns.
 *   7. Recreate every FK constraint using the original constraint names.
 *   8. Re-enable FK checks.
 */
export class ConvertPkToInt1775744766472 implements MigrationInterface {
  name = 'ConvertPkToInt1775744766472';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /* 1. Temporarily disable FK enforcement so truncate/alter operations
     *    on referenced tables do not fail mid-flight. */
    await queryRunner.query(`SET FOREIGN_KEY_CHECKS = 0`);

    /* 2. Drop every FK constraint that references an id column we are about
     *    to change. Must drop BEFORE altering column types — MySQL rejects
     *    ALTER COLUMN on an FK-referenced column even with FK checks off
     *    in some server versions. */

    /* users FKs */
    await queryRunner.query(
      `ALTER TABLE \`users\` DROP FOREIGN KEY \`FK_users_program_id\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` DROP FOREIGN KEY \`FK_users_center_id\``,
    );

    /* projects FKs */
    await queryRunner.query(
      `ALTER TABLE \`projects\` DROP FOREIGN KEY \`FK_projects_center\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`projects\` DROP FOREIGN KEY \`FK_projects_created_by\``,
    );

    /* project_mappings FKs */
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP FOREIGN KEY \`FK_project_mappings_project\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP FOREIGN KEY \`FK_project_mappings_program\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP FOREIGN KEY \`FK_project_mappings_submitted_by\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP FOREIGN KEY \`FK_project_mappings_reviewed_by\``,
    );

    /* 3. Drop the join table entirely — simpler than altering 2 FK columns
     *    in place, and we will recreate it below with the new int types. */
    await queryRunner.query(`DROP TABLE \`project_countries\``);

    /* 4. For every PK table: wipe data, drop the varchar(36) id, and add a
     *    fresh AUTO_INCREMENT int id as the first column. We use TRUNCATE
     *    for a clean slate (resets auto-increment and is faster than DELETE).
     *    TRUNCATE works here because FK checks are currently disabled. */

    /* users */
    await queryRunner.query(`TRUNCATE TABLE \`users\``);
    await queryRunner.query(`ALTER TABLE \`users\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`users\` ADD \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
    );

    /* centers */
    await queryRunner.query(`TRUNCATE TABLE \`centers\``);
    await queryRunner.query(`ALTER TABLE \`centers\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`centers\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`centers\` ADD \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
    );

    /* programs */
    await queryRunner.query(`TRUNCATE TABLE \`programs\``);
    await queryRunner.query(`ALTER TABLE \`programs\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`programs\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`programs\` ADD \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
    );

    /* countries */
    await queryRunner.query(`TRUNCATE TABLE \`countries\``);
    await queryRunner.query(`ALTER TABLE \`countries\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`countries\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`countries\` ADD \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
    );

    /* action_areas */
    await queryRunner.query(`TRUNCATE TABLE \`action_areas\``);
    await queryRunner.query(`ALTER TABLE \`action_areas\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`action_areas\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`action_areas\` ADD \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
    );

    /* projects */
    await queryRunner.query(`TRUNCATE TABLE \`projects\``);
    await queryRunner.query(`ALTER TABLE \`projects\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`projects\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`projects\` ADD \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
    );

    /* project_mappings */
    await queryRunner.query(`TRUNCATE TABLE \`project_mappings\``);
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP PRIMARY KEY`,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP COLUMN \`id\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` ADD \`id\` int NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST`,
    );

    /* 5. Convert every FK column from varchar(36) to int, preserving each
     *    column's original nullability. Tables are empty so the type change
     *    is always safe. */

    /* users FK columns (both nullable) */
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY \`program_id\` int NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY \`center_id\` int NULL`,
    );

    /* projects FK columns (both NOT NULL) */
    await queryRunner.query(
      `ALTER TABLE \`projects\` MODIFY \`center_id\` int NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`projects\` MODIFY \`created_by\` int NOT NULL`,
    );

    /* project_mappings FK columns */
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` MODIFY \`project_id\` int NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` MODIFY \`program_id\` int NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` MODIFY \`submitted_by\` int NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` MODIFY \`reviewed_by\` int NULL`,
    );

    /* 6. Recreate the project_countries join table with int FK columns.
     *    Same structure/indexes/FK names as the original migration so that
     *    any code depending on the schema continues to work unchanged. */
    await queryRunner.query(`
      CREATE TABLE \`project_countries\` (
        \`project_id\` int NOT NULL,
        \`country_id\` int NOT NULL,
        INDEX \`IDX_project_countries_project_id\` (\`project_id\`),
        INDEX \`IDX_project_countries_country_id\` (\`country_id\`),
        PRIMARY KEY (\`project_id\`, \`country_id\`),
        CONSTRAINT \`FK_project_countries_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT \`FK_project_countries_country\` FOREIGN KEY (\`country_id\`) REFERENCES \`countries\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    /* 7. Recreate every FK constraint with its original name and referential
     *    action so the rest of the codebase (and future migrations) can keep
     *    referring to the same constraint identifiers. */

    /* users -> programs / centers */
    await queryRunner.query(`
      ALTER TABLE \`users\`
        ADD CONSTRAINT \`FK_users_program_id\`
        FOREIGN KEY (\`program_id\`) REFERENCES \`programs\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`users\`
        ADD CONSTRAINT \`FK_users_center_id\`
        FOREIGN KEY (\`center_id\`) REFERENCES \`centers\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);

    /* projects -> centers / users */
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD CONSTRAINT \`FK_projects_center\`
        FOREIGN KEY (\`center_id\`) REFERENCES \`centers\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD CONSTRAINT \`FK_projects_created_by\`
        FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);

    /* project_mappings -> projects / programs / users */
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD CONSTRAINT \`FK_project_mappings_project\`
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD CONSTRAINT \`FK_project_mappings_program\`
        FOREIGN KEY (\`program_id\`) REFERENCES \`programs\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD CONSTRAINT \`FK_project_mappings_submitted_by\`
        FOREIGN KEY (\`submitted_by\`) REFERENCES \`users\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD CONSTRAINT \`FK_project_mappings_reviewed_by\`
        FOREIGN KEY (\`reviewed_by\`) REFERENCES \`users\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);

    /* 8. Re-enable FK enforcement now that the schema is consistent. */
    await queryRunner.query(`SET FOREIGN_KEY_CHECKS = 1`);
  }

  /**
   * DESTRUCTIVE ROLLBACK — wipes all data and reverts every id column
   * back to `varchar(36)` UUID (no AUTO_INCREMENT). After running this,
   * re-run the CLARISA sync and the CSV import to repopulate reference
   * data and projects.
   *
   * Mirrors up() in reverse order: drop FKs, drop join table, truncate
   * and convert id columns back to varchar(36), convert FK columns back
   * to varchar(36), recreate join table, recreate FK constraints.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    /* Disable FK enforcement for the duration of the rollback. */
    await queryRunner.query(`SET FOREIGN_KEY_CHECKS = 0`);

    /* Drop all FK constraints that reference the id columns. */
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP FOREIGN KEY \`FK_project_mappings_reviewed_by\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP FOREIGN KEY \`FK_project_mappings_submitted_by\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP FOREIGN KEY \`FK_project_mappings_program\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP FOREIGN KEY \`FK_project_mappings_project\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`projects\` DROP FOREIGN KEY \`FK_projects_created_by\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`projects\` DROP FOREIGN KEY \`FK_projects_center\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` DROP FOREIGN KEY \`FK_users_center_id\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` DROP FOREIGN KEY \`FK_users_program_id\``,
    );

    /* Drop the join table — will be recreated with varchar(36) columns. */
    await queryRunner.query(`DROP TABLE \`project_countries\``);

    /* Wipe data and revert every PK column back to varchar(36).
     * Note: AUTO_INCREMENT is NOT reapplied — the original schema used
     * plain UUID strings with no auto-generation at the DB level. */

    /* project_mappings */
    await queryRunner.query(`TRUNCATE TABLE \`project_mappings\``);
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP PRIMARY KEY`,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` DROP COLUMN \`id\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` ADD \`id\` varchar(36) NOT NULL PRIMARY KEY FIRST`,
    );

    /* projects */
    await queryRunner.query(`TRUNCATE TABLE \`projects\``);
    await queryRunner.query(`ALTER TABLE \`projects\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`projects\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`projects\` ADD \`id\` varchar(36) NOT NULL PRIMARY KEY FIRST`,
    );

    /* action_areas */
    await queryRunner.query(`TRUNCATE TABLE \`action_areas\``);
    await queryRunner.query(`ALTER TABLE \`action_areas\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`action_areas\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`action_areas\` ADD \`id\` varchar(36) NOT NULL PRIMARY KEY FIRST`,
    );

    /* countries */
    await queryRunner.query(`TRUNCATE TABLE \`countries\``);
    await queryRunner.query(`ALTER TABLE \`countries\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`countries\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`countries\` ADD \`id\` varchar(36) NOT NULL PRIMARY KEY FIRST`,
    );

    /* programs */
    await queryRunner.query(`TRUNCATE TABLE \`programs\``);
    await queryRunner.query(`ALTER TABLE \`programs\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`programs\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`programs\` ADD \`id\` varchar(36) NOT NULL PRIMARY KEY FIRST`,
    );

    /* centers */
    await queryRunner.query(`TRUNCATE TABLE \`centers\``);
    await queryRunner.query(`ALTER TABLE \`centers\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`centers\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`centers\` ADD \`id\` varchar(36) NOT NULL PRIMARY KEY FIRST`,
    );

    /* users */
    await queryRunner.query(`TRUNCATE TABLE \`users\``);
    await queryRunner.query(`ALTER TABLE \`users\` DROP PRIMARY KEY`);
    await queryRunner.query(`ALTER TABLE \`users\` DROP COLUMN \`id\``);
    await queryRunner.query(
      `ALTER TABLE \`users\` ADD \`id\` varchar(36) NOT NULL PRIMARY KEY FIRST`,
    );

    /* Revert FK columns back to varchar(36), preserving nullability. */
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY \`program_id\` varchar(36) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`users\` MODIFY \`center_id\` varchar(36) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`projects\` MODIFY \`center_id\` varchar(36) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`projects\` MODIFY \`created_by\` varchar(36) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` MODIFY \`project_id\` varchar(36) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` MODIFY \`program_id\` varchar(36) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` MODIFY \`submitted_by\` varchar(36) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`project_mappings\` MODIFY \`reviewed_by\` varchar(36) NULL`,
    );

    /* Recreate join table with varchar(36) columns — identical to the
     * original CreateProjectsTable migration. */
    await queryRunner.query(`
      CREATE TABLE \`project_countries\` (
        \`project_id\` varchar(36) NOT NULL,
        \`country_id\` varchar(36) NOT NULL,
        INDEX \`IDX_project_countries_project_id\` (\`project_id\`),
        INDEX \`IDX_project_countries_country_id\` (\`country_id\`),
        PRIMARY KEY (\`project_id\`, \`country_id\`),
        CONSTRAINT \`FK_project_countries_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT \`FK_project_countries_country\` FOREIGN KEY (\`country_id\`) REFERENCES \`countries\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    /* Recreate all FK constraints with their original names. */
    await queryRunner.query(`
      ALTER TABLE \`users\`
        ADD CONSTRAINT \`FK_users_program_id\`
        FOREIGN KEY (\`program_id\`) REFERENCES \`programs\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`users\`
        ADD CONSTRAINT \`FK_users_center_id\`
        FOREIGN KEY (\`center_id\`) REFERENCES \`centers\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD CONSTRAINT \`FK_projects_center\`
        FOREIGN KEY (\`center_id\`) REFERENCES \`centers\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD CONSTRAINT \`FK_projects_created_by\`
        FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD CONSTRAINT \`FK_project_mappings_project\`
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD CONSTRAINT \`FK_project_mappings_program\`
        FOREIGN KEY (\`program_id\`) REFERENCES \`programs\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD CONSTRAINT \`FK_project_mappings_submitted_by\`
        FOREIGN KEY (\`submitted_by\`) REFERENCES \`users\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_mappings\`
        ADD CONSTRAINT \`FK_project_mappings_reviewed_by\`
        FOREIGN KEY (\`reviewed_by\`) REFERENCES \`users\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);

    await queryRunner.query(`SET FOREIGN_KEY_CHECKS = 1`);
  }
}
