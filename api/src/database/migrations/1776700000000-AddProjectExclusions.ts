import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `project_exclusions` table, which stores per-center exclusion
 * records for projects.
 *
 * Exclusion is a center-local concept: a center rep (or admin) can hide a
 * project from their center's view without modifying the project entity
 * itself. Other roles and other centers are completely unaffected.
 *
 * Key design points:
 *  - UNIQUE(project_id, center_id) — one exclusion record per project per
 *    center. Attempting to exclude an already-excluded project returns a 409.
 *  - FK to projects CASCADE DELETE — if a project is archived/deleted the
 *    exclusion row is cleaned up automatically.
 *  - FK to centers CASCADE DELETE — if a center is removed its exclusion
 *    records are also cleaned up.
 *  - FK to users RESTRICT DELETE — we keep the audit trail even if a user
 *    account is deactivated; deletion of the user is blocked while rows
 *    reference them (consistent with other actor FK patterns in this schema).
 */
export class AddProjectExclusions1776700000000 implements MigrationInterface {
  name = 'AddProjectExclusions1776700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create the project_exclusions table.
    await queryRunner.query(`
      CREATE TABLE \`project_exclusions\` (
        \`id\`                   INT          NOT NULL AUTO_INCREMENT,
        \`project_id\`           INT          NOT NULL,
        \`center_id\`            INT          NOT NULL,
        \`excluded_by_user_id\`  INT          NOT NULL,
        \`reason\`               TEXT         NOT NULL,
        \`excluded_at\`          DATETIME     NOT NULL,
        \`created_at\`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updated_at\`           DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                              ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 2. UNIQUE constraint — one exclusion per (project, center) pair.
    await queryRunner.query(`
      ALTER TABLE \`project_exclusions\`
        ADD CONSTRAINT \`UQ_project_exclusions_project_center\`
        UNIQUE (\`project_id\`, \`center_id\`)
    `);

    // 3. Supporting indexes for the two main read paths:
    //    - "is project X excluded for my center?" (project_id lookup)
    //    - "list all exclusions for my center" (center_id scan)
    await queryRunner.query(`
      CREATE INDEX \`IDX_project_exclusions_project_id\`
        ON \`project_exclusions\` (\`project_id\`)
    `);

    await queryRunner.query(`
      CREATE INDEX \`IDX_project_exclusions_center_id\`
        ON \`project_exclusions\` (\`center_id\`)
    `);

    // 4. Foreign keys — added after the table is fully shaped so any
    //    FK violation during migration development surfaces cleanly.

    // project_id → projects(id) CASCADE: remove exclusion when project is deleted.
    await queryRunner.query(`
      ALTER TABLE \`project_exclusions\`
        ADD CONSTRAINT \`FK_project_exclusions_project\`
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`)
        ON DELETE CASCADE ON UPDATE CASCADE
    `);

    // center_id → centers(id) CASCADE: remove exclusion when center is deleted.
    await queryRunner.query(`
      ALTER TABLE \`project_exclusions\`
        ADD CONSTRAINT \`FK_project_exclusions_center\`
        FOREIGN KEY (\`center_id\`) REFERENCES \`centers\`(\`id\`)
        ON DELETE CASCADE ON UPDATE CASCADE
    `);

    // excluded_by_user_id → users(id) RESTRICT: preserve audit trail;
    // user deletion is blocked while exclusion rows reference them.
    await queryRunner.query(`
      ALTER TABLE \`project_exclusions\`
        ADD CONSTRAINT \`FK_project_exclusions_excluded_by_user\`
        FOREIGN KEY (\`excluded_by_user_id\`) REFERENCES \`users\`(\`id\`)
        ON DELETE RESTRICT ON UPDATE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign keys before dropping the table (MySQL requires this).
    await queryRunner.query(`
      ALTER TABLE \`project_exclusions\`
        DROP FOREIGN KEY \`FK_project_exclusions_excluded_by_user\`
    `);

    await queryRunner.query(`
      ALTER TABLE \`project_exclusions\`
        DROP FOREIGN KEY \`FK_project_exclusions_center\`
    `);

    await queryRunner.query(`
      ALTER TABLE \`project_exclusions\`
        DROP FOREIGN KEY \`FK_project_exclusions_project\`
    `);

    // Indexes and unique constraint are dropped implicitly with the table.
    await queryRunner.query(`DROP TABLE \`project_exclusions\``);
  }
}
