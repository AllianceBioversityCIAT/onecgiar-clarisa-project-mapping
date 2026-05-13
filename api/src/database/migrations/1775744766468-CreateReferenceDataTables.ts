import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the four reference data tables synced from the CLARISA API:
 * centers, programs, countries, and action_areas.
 */
export class CreateReferenceDataTables1775744766468 implements MigrationInterface {
  name = 'CreateReferenceDataTables1775744766468';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /* Centers table */
    await queryRunner.query(`
      CREATE TABLE \`centers\` (
        \`id\` varchar(36) NOT NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`clarisa_id\` int NOT NULL,
        \`code\` varchar(50) NOT NULL,
        \`name\` varchar(255) NOT NULL,
        \`acronym\` varchar(50) NOT NULL,
        \`institution_id\` int NOT NULL,
        \`synced_at\` datetime NOT NULL,
        UNIQUE INDEX \`IDX_centers_clarisa_id\` (\`clarisa_id\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    /* Programs table */
    await queryRunner.query(`
      CREATE TABLE \`programs\` (
        \`id\` varchar(36) NOT NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`clarisa_id\` int NOT NULL,
        \`official_code\` varchar(50) NOT NULL,
        \`name\` varchar(255) NOT NULL,
        \`synced_at\` datetime NOT NULL,
        UNIQUE INDEX \`IDX_programs_clarisa_id\` (\`clarisa_id\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    /* Countries table */
    await queryRunner.query(`
      CREATE TABLE \`countries\` (
        \`id\` varchar(36) NOT NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`clarisa_id\` int NOT NULL,
        \`iso_alpha_2\` varchar(2) NOT NULL,
        \`iso_alpha_3\` varchar(3) NOT NULL,
        \`name\` varchar(255) NOT NULL,
        \`region\` varchar(255) NOT NULL,
        \`synced_at\` datetime NOT NULL,
        UNIQUE INDEX \`IDX_countries_clarisa_id\` (\`clarisa_id\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    /* Action areas table */
    await queryRunner.query(`
      CREATE TABLE \`action_areas\` (
        \`id\` varchar(36) NOT NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`clarisa_id\` int NOT NULL,
        \`name\` varchar(255) NOT NULL,
        \`description\` text NOT NULL,
        \`color\` varchar(50) NOT NULL,
        \`synced_at\` datetime NOT NULL,
        UNIQUE INDEX \`IDX_action_areas_clarisa_id\` (\`clarisa_id\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE \`action_areas\``);
    await queryRunner.query(`DROP TABLE \`countries\``);
    await queryRunner.query(`DROP TABLE \`programs\``);
    await queryRunner.query(`DROP TABLE \`centers\``);
  }
}
