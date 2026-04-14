import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Redesigns project_mappings from approve/reject to negotiation workflow.
 *
 * Changes:
 * 1. Alters status enum: pending/approved/rejected → draft/negotiating/agreed/locked/removed
 * 2. Adds center_agreed and program_agreed boolean flags
 * 3. Adds initiated_by FK and initiated_at timestamp
 * 4. Makes submitted_by and submitted_at nullable (legacy columns)
 * 5. Creates mapping_negotiations table for conversation history
 * 6. Migrates existing data: pending→negotiating, approved→locked, rejected→removed
 */
export class NegotiationWorkflow1776100000000 implements MigrationInterface {
  name = 'NegotiationWorkflow1776100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Step 1: Add new columns to project_mappings ──────────────────

    // Add center_agreed and program_agreed flags
    await queryRunner.query(`
      ALTER TABLE project_mappings
        ADD COLUMN center_agreed TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN program_agreed TINYINT(1) NOT NULL DEFAULT 0
    `);

    // Add initiated_by (nullable initially for data migration) and initiated_at
    await queryRunner.query(`
      ALTER TABLE project_mappings
        ADD COLUMN initiated_by INT NULL,
        ADD COLUMN initiated_at DATETIME NULL
    `);

    // Make submitted_by nullable (legacy column)
    await queryRunner.query(`
      ALTER TABLE project_mappings
        MODIFY COLUMN submitted_by INT NULL
    `);

    // Make submitted_at nullable (legacy column)
    await queryRunner.query(`
      ALTER TABLE project_mappings
        MODIFY COLUMN submitted_at DATETIME NULL
    `);

    // ── Step 2: Migrate existing data before changing the enum ───────

    // Copy submitted_by → initiated_by and submitted_at → initiated_at
    await queryRunner.query(`
      UPDATE project_mappings
        SET initiated_by = submitted_by,
            initiated_at = COALESCE(submitted_at, created_at)
        WHERE initiated_by IS NULL
    `);

    // Set agreement flags for approved mappings (both sides agreed)
    await queryRunner.query(`
      UPDATE project_mappings
        SET center_agreed = 1, program_agreed = 1
        WHERE status = 'approved'
    `);

    // ── Step 3: Change the status enum ──────────────────────────────

    // MySQL requires redefining the column to change enum values.
    // We first add the new values alongside old ones, migrate data, then remove old values.
    await queryRunner.query(`
      ALTER TABLE project_mappings
        MODIFY COLUMN status ENUM('pending','approved','rejected','draft','negotiating','agreed','locked','removed')
        NOT NULL DEFAULT 'draft'
    `);

    // Map old statuses to new ones
    await queryRunner.query(
      `UPDATE project_mappings SET status = 'negotiating' WHERE status = 'pending'`,
    );
    await queryRunner.query(
      `UPDATE project_mappings SET status = 'locked' WHERE status = 'approved'`,
    );
    await queryRunner.query(
      `UPDATE project_mappings SET status = 'removed' WHERE status = 'rejected'`,
    );

    // Now remove old enum values
    await queryRunner.query(`
      ALTER TABLE project_mappings
        MODIFY COLUMN status ENUM('draft','negotiating','agreed','locked','removed')
        NOT NULL DEFAULT 'draft'
    `);

    // ── Step 4: Add FK constraint for initiated_by ──────────────────

    // Make initiated_by NOT NULL now that all rows have a value
    await queryRunner.query(`
      ALTER TABLE project_mappings
        MODIFY COLUMN initiated_by INT NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE project_mappings
        ADD CONSTRAINT FK_project_mappings_initiated_by
        FOREIGN KEY (initiated_by) REFERENCES users(id) ON DELETE RESTRICT
    `);

    // ── Step 5: Create mapping_negotiations table ───────────────────

    await queryRunner.query(`
      CREATE TABLE mapping_negotiations (
        id INT NOT NULL AUTO_INCREMENT,
        mapping_id INT NOT NULL,
        actor_id INT NOT NULL,
        actor_role ENUM('center_rep','program_rep') NOT NULL,
        event_type ENUM('initiated','counter_proposed','agreed','reopened') NOT NULL,
        proposed_allocation DECIMAL(5,2) NULL,
        justification TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        INDEX IDX_mapping_negotiations_mapping (mapping_id),
        INDEX IDX_mapping_negotiations_actor (actor_id),
        INDEX IDX_mapping_negotiations_created (created_at),
        CONSTRAINT FK_mapping_negotiations_mapping
          FOREIGN KEY (mapping_id) REFERENCES project_mappings(id) ON DELETE CASCADE,
        CONSTRAINT FK_mapping_negotiations_actor
          FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // ── Step 6: Insert synthetic 'initiated' events for existing mappings ─

    await queryRunner.query(`
      INSERT INTO mapping_negotiations (mapping_id, actor_id, actor_role, event_type, proposed_allocation, created_at)
      SELECT
        pm.id,
        pm.initiated_by,
        'center_rep',
        'initiated',
        pm.allocation_percentage,
        COALESCE(pm.initiated_at, pm.created_at)
      FROM project_mappings pm
    `);

    // Insert synthetic 'agreed' events for locked (was approved) mappings
    await queryRunner.query(`
      INSERT INTO mapping_negotiations (mapping_id, actor_id, actor_role, event_type, created_at)
      SELECT
        pm.id,
        pm.initiated_by,
        'center_rep',
        'agreed',
        COALESCE(pm.reviewed_at, pm.updated_at)
      FROM project_mappings pm
      WHERE pm.status = 'locked'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ── Drop mapping_negotiations ────────────────────────────────────

    await queryRunner.query(`DROP TABLE IF EXISTS mapping_negotiations`);

    // ── Revert status enum ──────────────────────────────────────────

    // Add old values back alongside new ones
    await queryRunner.query(`
      ALTER TABLE project_mappings
        MODIFY COLUMN status ENUM('pending','approved','rejected','draft','negotiating','agreed','locked','removed')
        NOT NULL DEFAULT 'draft'
    `);

    // Map new statuses back to old ones
    await queryRunner.query(
      `UPDATE project_mappings SET status = 'pending' WHERE status IN ('draft','negotiating')`,
    );
    await queryRunner.query(
      `UPDATE project_mappings SET status = 'approved' WHERE status IN ('agreed','locked')`,
    );
    await queryRunner.query(
      `UPDATE project_mappings SET status = 'removed' WHERE status = 'removed'`,
    );
    // 'removed' doesn't map back perfectly, use 'rejected'
    await queryRunner.query(`
      ALTER TABLE project_mappings
        MODIFY COLUMN status ENUM('pending','approved','rejected','draft','negotiating','agreed','locked','removed')
        NOT NULL DEFAULT 'pending'
    `);
    await queryRunner.query(
      `UPDATE project_mappings SET status = 'rejected' WHERE status = 'removed'`,
    );

    // Remove new enum values
    await queryRunner.query(`
      ALTER TABLE project_mappings
        MODIFY COLUMN status ENUM('pending','approved','rejected')
        NOT NULL DEFAULT 'pending'
    `);

    // ── Drop FK and new columns ─────────────────────────────────────

    await queryRunner.query(`
      ALTER TABLE project_mappings
        DROP FOREIGN KEY FK_project_mappings_initiated_by
    `);

    await queryRunner.query(`
      ALTER TABLE project_mappings
        DROP COLUMN initiated_by,
        DROP COLUMN initiated_at,
        DROP COLUMN center_agreed,
        DROP COLUMN program_agreed
    `);

    // Restore submitted_by as NOT NULL
    await queryRunner.query(`
      ALTER TABLE project_mappings
        MODIFY COLUMN submitted_by INT NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE project_mappings
        MODIFY COLUMN submitted_at DATETIME NOT NULL
    `);
  }
}
