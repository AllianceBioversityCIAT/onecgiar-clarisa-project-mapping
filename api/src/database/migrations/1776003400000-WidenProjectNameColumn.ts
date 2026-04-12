import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens projects.name from varchar(255) to varchar(500) to accommodate
 * long project names from the TOC_Projects CSV import.
 */
export class WidenProjectNameColumn1776003400000 implements MigrationInterface {
  name = 'WidenProjectNameColumn1776003400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`projects\` MODIFY \`name\` varchar(500) NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`projects\` MODIFY \`name\` varchar(255) NOT NULL`,
    );
  }
}
