import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsersTable1775744766467 implements MigrationInterface {
  name = 'CreateUsersTable1775744766467';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`users\` (\`id\` varchar(36) NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), \`cognito_sub\` varchar(255) NOT NULL, \`email\` varchar(255) NOT NULL, \`first_name\` varchar(255) NOT NULL, \`last_name\` varchar(255) NOT NULL, \`role\` enum ('admin', 'program_rep', 'center_rep') NULL, \`program_id\` varchar(255) NULL, \`center_id\` varchar(255) NULL, \`is_active\` tinyint NOT NULL DEFAULT 1, UNIQUE INDEX \`IDX_1ac76d6d17ea198c621bdc4e29\` (\`cognito_sub\`), UNIQUE INDEX \`IDX_97672ac88f789774dd47f7c8be\` (\`email\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX \`IDX_97672ac88f789774dd47f7c8be\` ON \`users\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_1ac76d6d17ea198c621bdc4e29\` ON \`users\``,
    );
    await queryRunner.query(`DROP TABLE \`users\``);
  }
}
