import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seeds a `unit-admin@codeobia.com` dev user with `role = 'unit_admin'`.
 *
 * The dev-login endpoints auto-create users on first hit, but they
 * land with `role = NULL`. For consistent Playwright testing of the
 * unit-admin flows we need the role pre-assigned.
 *
 * Idempotent: `INSERT IGNORE` skips if a row with this email already
 * exists (the email column is unique). Down removes the seed only if
 * the role is still `unit_admin` and no other side-state has been
 * attached, matching the pattern in AddUnitAdminRole's down guard.
 */
export class SeedUnitAdminDevUser1776300300000 implements MigrationInterface {
  name = 'SeedUnitAdminDevUser1776300300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT IGNORE INTO \`users\`
        (cognito_sub, email, first_name, last_name, role, is_active)
      VALUES
        ('dev-unit-admin@codeobia.com', 'unit-admin@codeobia.com', 'Unit', 'Admin', 'unit_admin', 1)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM \`users\`
      WHERE email = 'unit-admin@codeobia.com'
        AND role = 'unit_admin'
        AND cognito_sub = 'dev-unit-admin@codeobia.com'
    `);
  }
}
