import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retires the mapping-level `locked` status in favor of the project-level
 * `negotiation_locked` boolean as the single source of truth for lock state.
 *
 * For every mapping currently in `locked` status:
 *  1. Flip its project's `negotiation_locked` flag to 1.
 *  2. Demote the mapping's status back to `agreed` (since that is what
 *     `locked` actually represented — both sides had agreed and the round
 *     was finalized).
 */
export class RetireMappingLockedStatus1776188000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE projects p
      JOIN (
        SELECT DISTINCT project_id
        FROM project_mappings
        WHERE status = 'locked'
      ) m ON m.project_id = p.id
      SET p.negotiation_locked = 1
    `);

    await queryRunner.query(`
      UPDATE project_mappings
      SET status = 'agreed', center_agreed = 1, program_agreed = 1
      WHERE status = 'locked'
    `);
  }

  public async down(): Promise<void> {
    // No-op: we don't know which mappings were originally locked vs agreed.
  }
}
