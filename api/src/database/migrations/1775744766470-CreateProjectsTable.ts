import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the projects table and the project_countries join table
 * for the many-to-many relationship between projects and countries.
 */
export class CreateProjectsTable1775744766470 implements MigrationInterface {
  name = 'CreateProjectsTable1775744766470';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /* Projects table */
    await queryRunner.query(`
      CREATE TABLE \`projects\` (
        \`id\` varchar(36) NOT NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`code\` varchar(50) NOT NULL,
        \`name\` varchar(255) NOT NULL,
        \`description\` text NULL,
        \`summary\` text NULL,
        \`results\` text NULL,
        \`start_date\` date NULL,
        \`end_date\` date NULL,
        \`total_budget\` decimal(10,2) NOT NULL DEFAULT 0,
        \`remaining_budget\` decimal(10,2) NOT NULL DEFAULT 0,
        \`funding_source\` enum('window3', 'bilateral', 'srv', 'other') NULL,
        \`funder\` varchar(255) NULL,
        \`status\` enum('draft', 'active', 'archived') NOT NULL DEFAULT 'active',
        \`center_id\` varchar(36) NOT NULL,
        \`created_by\` varchar(36) NOT NULL,
        UNIQUE INDEX \`IDX_projects_code\` (\`code\`),
        INDEX \`IDX_projects_center_id\` (\`center_id\`),
        INDEX \`IDX_projects_status\` (\`status\`),
        INDEX \`IDX_projects_created_by\` (\`created_by\`),
        PRIMARY KEY (\`id\`),
        CONSTRAINT \`FK_projects_center\` FOREIGN KEY (\`center_id\`) REFERENCES \`centers\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT \`FK_projects_created_by\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    /* Project-Countries join table */
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE \`project_countries\``);
    await queryRunner.query(`DROP TABLE \`projects\``);
  }
}
