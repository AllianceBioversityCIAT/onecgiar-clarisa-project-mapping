import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `project_audit_events` — append-only audit log for project
 * metadata edits and snapshot republishes.
 *
 * One row is written per changed field (i.e. editing `name` and
 * `total_budget` in a single PATCH writes 2 rows). `value_before` and
 * `value_after` are JSON-encoded so the schema can carry strings,
 * numbers, and dates uniformly without a per-type column.
 *
 * FK behavior:
 *  - `project_id` ON DELETE CASCADE — projects do not delete in
 *     practice; if one is, leaving orphan rows pointing nowhere is
 *     worse than losing them. Revisit if soft-delete lands.
 *  - `actor_user_id` ON DELETE RESTRICT — never destroy attribution.
 *
 * Down: drops the table. Audit history is unrecoverable on rollback.
 */
export class AddProjectAuditEvents1776300100000 implements MigrationInterface {
  name = 'AddProjectAuditEvents1776300100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE project_audit_events (
        id INT NOT NULL AUTO_INCREMENT,
        project_id INT NOT NULL,
        actor_user_id INT NOT NULL,
        actor_role ENUM('admin','center_rep','program_rep','workflow_admin','unit_admin') NOT NULL,
        event_type ENUM('field_edited','snapshot_republished') NOT NULL,
        field_name VARCHAR(100) NULL,
        value_before JSON NULL,
        value_after JSON NULL,
        justification TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        INDEX IDX_project_audit_project (project_id, created_at),
        INDEX IDX_project_audit_actor (actor_user_id, created_at),
        CONSTRAINT FK_project_audit_project
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        CONSTRAINT FK_project_audit_actor
          FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS project_audit_events`);
  }
}
