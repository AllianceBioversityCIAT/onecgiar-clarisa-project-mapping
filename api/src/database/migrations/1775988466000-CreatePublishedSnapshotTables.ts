import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates tables for the published snapshot system.
 *
 * published_snapshots — versioned snapshots of the project portfolio,
 * triggered by an admin. Only one snapshot is active at a time.
 *
 * published_projects — denormalized project data frozen at snapshot time.
 * Mappings and countries are stored as JSON columns since they are always
 * read alongside the project row, never queried independently.
 */
export class CreatePublishedSnapshotTables1775988466000 implements MigrationInterface {
  name = 'CreatePublishedSnapshotTables1775988466000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`published_snapshots\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`version_label\` varchar(100) NOT NULL,
        \`description\` text NULL,
        \`published_at\` datetime NOT NULL,
        \`published_by\` int NOT NULL,
        \`project_count\` int NOT NULL DEFAULT 0,
        \`total_budget\` decimal(14,2) NOT NULL DEFAULT 0,
        \`summary_stats\` json NOT NULL,
        \`is_active\` tinyint(1) NOT NULL DEFAULT 1,
        INDEX \`IDX_published_snapshots_is_active\` (\`is_active\`),
        INDEX \`IDX_published_snapshots_published_at\` (\`published_at\`),
        PRIMARY KEY (\`id\`),
        CONSTRAINT \`FK_published_snapshots_user\` FOREIGN KEY (\`published_by\`)
          REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await queryRunner.query(`
      CREATE TABLE \`published_projects\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`snapshot_id\` int NOT NULL,
        \`source_project_id\` int NOT NULL,
        \`code\` varchar(50) NOT NULL,
        \`name\` varchar(255) NOT NULL,
        \`description\` text NULL,
        \`center_name\` varchar(255) NOT NULL,
        \`center_acronym\` varchar(50) NOT NULL,
        \`countries\` json NOT NULL,
        \`total_budget\` decimal(14,2) NOT NULL DEFAULT 0,
        \`funding_source\` varchar(60) NULL,
        \`funder\` varchar(255) NULL,
        \`status\` varchar(20) NOT NULL,
        \`start_date\` date NULL,
        \`end_date\` date NULL,
        \`mappings\` json NOT NULL,
        INDEX \`IDX_published_projects_snapshot_id\` (\`snapshot_id\`),
        INDEX \`IDX_published_projects_center_name\` (\`center_name\`),
        INDEX \`IDX_published_projects_snapshot_code\` (\`snapshot_id\`, \`code\`),
        PRIMARY KEY (\`id\`),
        CONSTRAINT \`FK_published_projects_snapshot\` FOREIGN KEY (\`snapshot_id\`)
          REFERENCES \`published_snapshots\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE \`published_projects\``);
    await queryRunner.query(`DROP TABLE \`published_snapshots\``);
  }
}
