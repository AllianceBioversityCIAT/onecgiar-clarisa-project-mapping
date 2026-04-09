import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the project_mappings table for tracking project-to-program
 * allocation mappings with approval workflow support.
 */
export class CreateProjectMappingsTable1775744766471 implements MigrationInterface {
  name = 'CreateProjectMappingsTable1775744766471';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`project_mappings\` (
        \`id\` varchar(36) NOT NULL,
        \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        \`project_id\` varchar(36) NOT NULL,
        \`program_id\` varchar(36) NOT NULL,
        \`allocation_percentage\` decimal(5,2) NOT NULL,
        \`complementarity_rating\` enum('high', 'medium', 'low') NULL,
        \`efficiency_rating\` enum('high', 'medium', 'low') NULL,
        \`status\` enum('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        \`rejection_reason\` text NULL,
        \`submitted_by\` varchar(36) NOT NULL,
        \`submitted_at\` datetime NOT NULL,
        \`reviewed_by\` varchar(36) NULL,
        \`reviewed_at\` datetime NULL,
        UNIQUE INDEX \`UQ_project_mappings_project_program\` (\`project_id\`, \`program_id\`),
        INDEX \`IDX_project_mappings_project_id\` (\`project_id\`),
        INDEX \`IDX_project_mappings_program_id\` (\`program_id\`),
        INDEX \`IDX_project_mappings_status\` (\`status\`),
        INDEX \`IDX_project_mappings_submitted_by\` (\`submitted_by\`),
        PRIMARY KEY (\`id\`),
        CONSTRAINT \`FK_project_mappings_project\` FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT \`FK_project_mappings_program\` FOREIGN KEY (\`program_id\`) REFERENCES \`programs\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT \`FK_project_mappings_submitted_by\` FOREIGN KEY (\`submitted_by\`) REFERENCES \`users\`(\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
        CONSTRAINT \`FK_project_mappings_reviewed_by\` FOREIGN KEY (\`reviewed_by\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE \`project_mappings\``);
  }
}
