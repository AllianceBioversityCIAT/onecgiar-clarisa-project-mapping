import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds foreign-key constraints from the `users` table to the
 * `programs` and `centers` reference data tables.
 *
 * Must run after CreateReferenceDataTables so the target tables exist.
 */
export class AddForeignKeysToUsers1775744766469
  implements MigrationInterface
{
  name = 'AddForeignKeysToUsers1775744766469';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /*
     * Convert the entire users table (including all columns) to
     * utf8mb4 with the 0900_ai_ci collation so it matches the
     * reference data tables created with DEFAULT CHARSET=utf8mb4.
     * Also resize FK columns from varchar(255) to varchar(36).
     */
    await queryRunner.query(`
      ALTER TABLE \`users\`
        CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci
    `);

    await queryRunner.query(`
      ALTER TABLE \`users\`
        MODIFY \`program_id\` varchar(36) NULL,
        MODIFY \`center_id\` varchar(36) NULL
    `);

    /* Add FK: users.program_id -> programs.id */
    await queryRunner.query(`
      ALTER TABLE \`users\`
        ADD CONSTRAINT \`FK_users_program_id\`
        FOREIGN KEY (\`program_id\`) REFERENCES \`programs\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);

    /* Add FK: users.center_id -> centers.id */
    await queryRunner.query(`
      ALTER TABLE \`users\`
        ADD CONSTRAINT \`FK_users_center_id\`
        FOREIGN KEY (\`center_id\`) REFERENCES \`centers\`(\`id\`)
        ON DELETE SET NULL ON UPDATE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`users\` DROP FOREIGN KEY \`FK_users_center_id\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`users\` DROP FOREIGN KEY \`FK_users_program_id\`
    `);

    /* Revert column sizes back to varchar(255) */
    await queryRunner.query(`
      ALTER TABLE \`users\`
        MODIFY \`program_id\` varchar(255) NULL,
        MODIFY \`center_id\` varchar(255) NULL
    `);
  }
}
