// CLAUDE.md note: this migration drops project_audit_events and consolidates into audit_events.
// Old rows are preserved in audit_events. The down() migration is a best-effort restore — JSON
// unpacking may not perfectly round-trip if rows were inserted via the new Task 3 wirings (those
// wirings store multi-field changes in one row, while the old table stored one field per row).
// This asymmetry is acceptable per plan §6 because once Task 3 ships, down() is no longer a clean
// restore.
//
// Money columns: not applicable here — there are no decimal columns in either the old or new table.

import { MigrationInterface, QueryRunner } from 'typeorm';

// ============================================================================
// DEPLOY ORDER: This migration MUST be deployed together with the code-side
// switch that replaces ProjectAuditEvent reads/writes with AuditService.record()
// calls (Task #5 / Phase A.3). Running this migration alone in a shared
// environment will break unit_admin metadata edits and project Excel exports
// because the application still references the dropped project_audit_events
// table. Local dev is unaffected because the table is empty there.
// ============================================================================

/**
 * Creates the unified `audit_events` table — a polymorphic, append-only audit
 * log spanning every entity in the system (projects, mappings, users, snapshots,
 * import runs, CLARISA syncs, system events). Replaces the project-only
 * `project_audit_events` table.
 *
 * Migration steps (up):
 *   1. CREATE TABLE audit_events with the new shape.
 *   2. Copy every row from project_audit_events into audit_events, mapping the
 *      old (project_id, event_type, field_name, value_before, value_after)
 *      shape into the new (entity_type='project', entity_id, action, changes,
 *      summary) shape. JOIN users to denormalize actor_display_name + email.
 *   3. DROP TABLE project_audit_events.
 *
 * Down: recreates project_audit_events with the original DDL (verbatim from
 * 1776300100000-AddProjectAuditEvents) and best-effort copies project-scoped
 * rows back. Snapshot republishes and field edits round-trip cleanly; rows
 * written by Task 3 wirings (multi-field changes in a single row) won't, see
 * file header note.
 *
 * The TypeScript ActorRole enum is widened to include `system` in Task 2 — not
 * here. This migration only widens the DB-side enum on the new column.
 *
 * No FK on audit_events.entity_id: the column is polymorphic across multiple
 * tables and a single FK target is not possible. The application is responsible
 * for keeping it consistent (writes are append-only, never updated).
 */
export class AddAuditEventsUnified1776400000000 implements MigrationInterface {
  name = 'AddAuditEventsUnified1776400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create the unified audit_events table.
    await queryRunner.query(`
      CREATE TABLE audit_events (
        id BIGINT NOT NULL AUTO_INCREMENT,
        entity_type ENUM(
          'project',
          'project_mapping',
          'user',
          'published_snapshot',
          'import_run',
          'clarisa_sync',
          'system'
        ) NOT NULL,
        entity_id INT NULL,
        action VARCHAR(64) NOT NULL,
        actor_user_id INT NULL,
        actor_role ENUM(
          'admin',
          'center_rep',
          'program_rep',
          'workflow_admin',
          'unit_admin',
          'system'
        ) NOT NULL,
        actor_display_name VARCHAR(255) NOT NULL,
        actor_email VARCHAR(255) NULL,
        changes JSON NULL,
        summary VARCHAR(500) NULL,
        justification TEXT NULL,
        request_id VARCHAR(64) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        INDEX idx_audit_entity (entity_type, entity_id, created_at DESC),
        INDEX idx_audit_actor (actor_user_id, created_at DESC),
        INDEX idx_audit_action (action, created_at DESC),
        INDEX idx_audit_created_at (created_at DESC),
        CONSTRAINT FK_audit_events_actor_user
          FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
        -- No FK on entity_id: this column is polymorphic (entity_type tells you
        -- which table to resolve against). Append-only writes are governed at
        -- the application layer.
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 2. Copy rows from project_audit_events. LEFT JOIN users so that even if
    //    a user row is missing (shouldn't happen given ON DELETE RESTRICT, but
    //    defensive), we still preserve the audit row with a fallback display
    //    name. JSON_OBJECT preserves child JSON values without stringifying
    //    because value_before/value_after are stored as native JSON columns
    //    (verified in 1776300100000-AddProjectAuditEvents.ts).
    await queryRunner.query(`
      INSERT INTO audit_events (
        entity_type,
        entity_id,
        action,
        actor_user_id,
        actor_role,
        actor_display_name,
        actor_email,
        changes,
        summary,
        justification,
        request_id,
        created_at
      )
      SELECT
        'project' AS entity_type,
        pae.project_id AS entity_id,
        CASE pae.event_type
          WHEN 'field_edited'        THEN 'project.metadata_update'
          WHEN 'snapshot_republished' THEN 'project.snapshot_republished'
        END AS action,
        pae.actor_user_id,
        -- Explicit string-based enum conversion: MySQL enum-to-enum copies use
        -- the ordinal index by default, which would silently corrupt rows if
        -- the source/destination enum orderings ever diverge. CAST AS CHAR
        -- forces value-based mapping. The new 'system' value is absent from
        -- the source enum, so this is purely defensive.
        CAST(pae.actor_role AS CHAR) AS actor_role,
        COALESCE(
          NULLIF(TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))), ''),
          u.email,
          '(unknown)'
        ) AS actor_display_name,
        u.email AS actor_email,
        CASE pae.event_type
          WHEN 'field_edited' THEN
            JSON_OBJECT(
              COALESCE(pae.field_name, '(unknown)'),
              JSON_OBJECT(
                'before', pae.value_before,
                'after',  pae.value_after
              )
            )
          WHEN 'snapshot_republished' THEN NULL
        END AS changes,
        CASE pae.event_type
          WHEN 'field_edited'        THEN CONCAT('Edited field: ', COALESCE(pae.field_name, '(unknown)'))
          WHEN 'snapshot_republished' THEN 'Republished snapshot'
        END AS summary,
        pae.justification,
        NULL AS request_id,
        -- Precision drop: source DATETIME(6) → destination DATETIME(3). This
        -- is intentional per plan §3.2 — millisecond precision is sufficient
        -- for audit timestamps, and aligns with the new audit_events DDL.
        pae.created_at
      FROM project_audit_events pae
      LEFT JOIN users u ON u.id = pae.actor_user_id
    `);

    // 2a. Row-count parity check: source and destination row counts must match
    //     before we drop the source. SIGNAL can't be used outside a stored
    //     procedure in plain SQL, so we enforce this at the TypeScript level —
    //     two COUNT(*) queries, then throw before the DROP if they diverge.
    //     This aborts the migration in a transactional state where TypeORM
    //     will roll back the CREATE + INSERT cleanly.
    const srcCountRows = (await queryRunner.query(
      `SELECT COUNT(*) AS c FROM project_audit_events`,
    )) as Array<{ c: number | string }>;
    const dstCountRows = (await queryRunner.query(
      `SELECT COUNT(*) AS c FROM audit_events
       WHERE entity_type = 'project'
         AND action IN ('project.metadata_update', 'project.snapshot_republished')`,
    )) as Array<{ c: number | string }>;
    const srcCount = Number(srcCountRows[0]?.c ?? 0);
    const dstCount = Number(dstCountRows[0]?.c ?? 0);
    if (srcCount !== dstCount) {
      throw new Error(
        `AddAuditEventsUnified parity check failed: project_audit_events has ${srcCount} rows ` +
          `but audit_events received ${dstCount} project rows. Aborting before DROP.`,
      );
    }

    // 3. Drop the legacy table now that data has been migrated and verified.
    await queryRunner.query(`DROP TABLE IF EXISTS project_audit_events`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Recreate project_audit_events with the exact original DDL from
    //    1776300100000-AddProjectAuditEvents.ts (copied verbatim).
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

    // 2. Best-effort copy back. Filters:
    //    - Only project-scoped rows (entity_type='project') with a known action.
    //    - Only rows whose actor_user_id is non-null AND actor_role is one of
    //      the original 5 values (the legacy table forbids NULL actors and the
    //      'system' role doesn't fit the original enum).
    //
    //    For field_edited rows, we extract the first key in the `changes`
    //    JSON object as field_name. This works cleanly for legacy rows (they
    //    only ever had one key) but if Task 3 wirings have already written
    //    multi-key changes payloads, only the first field is round-tripped.
    //    See file header note — this asymmetry is documented + accepted.
    await queryRunner.query(`
      INSERT INTO project_audit_events (
        project_id,
        actor_user_id,
        actor_role,
        event_type,
        field_name,
        value_before,
        value_after,
        justification,
        created_at
      )
      SELECT
        ae.entity_id AS project_id,
        ae.actor_user_id,
        ae.actor_role,
        CASE ae.action
          WHEN 'project.metadata_update'      THEN 'field_edited'
          WHEN 'project.snapshot_republished' THEN 'snapshot_republished'
        END AS event_type,
        CASE
          WHEN ae.action = 'project.metadata_update' AND ae.changes IS NOT NULL
            THEN JSON_UNQUOTE(JSON_EXTRACT(JSON_KEYS(ae.changes), '$[0]'))
          ELSE NULL
        END AS field_name,
        CASE
          WHEN ae.action = 'project.metadata_update' AND ae.changes IS NOT NULL
            THEN JSON_EXTRACT(
                   ae.changes,
                   CONCAT('$.', JSON_UNQUOTE(JSON_EXTRACT(JSON_KEYS(ae.changes), '$[0]')), '.before')
                 )
          ELSE NULL
        END AS value_before,
        CASE
          WHEN ae.action = 'project.metadata_update' AND ae.changes IS NOT NULL
            THEN JSON_EXTRACT(
                   ae.changes,
                   CONCAT('$.', JSON_UNQUOTE(JSON_EXTRACT(JSON_KEYS(ae.changes), '$[0]')), '.after')
                 )
          ELSE NULL
        END AS value_after,
        ae.justification,
        ae.created_at
      FROM audit_events ae
      WHERE ae.entity_type = 'project'
        AND ae.action IN ('project.metadata_update', 'project.snapshot_republished')
        AND ae.actor_user_id IS NOT NULL
        AND ae.actor_role IN ('admin','center_rep','program_rep','workflow_admin','unit_admin')
        -- Skip metadata_update rows with empty/missing changes payload, which
        -- would produce bogus '$.null.before' / '$.null.after' extraction
        -- paths. Snapshot-republish rows have no changes payload by design,
        -- so they bypass this guard.
        AND (ae.action = 'project.snapshot_republished' OR JSON_LENGTH(ae.changes) > 0)
    `);

    // 3. Drop the unified table.
    await queryRunner.query(`DROP TABLE audit_events`);
  }
}
