import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Promotes any legacy `project_mappings` rows still in `draft` status to
 * `negotiating`. The new workflow skips `draft` on create (center reps open
 * negotiation immediately), so stranded drafts had no UI path forward.
 */
export class PromoteDraftMappingsToNegotiating1776186000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE project_mappings SET status = 'negotiating' WHERE status = 'draft'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: cannot reliably restore which rows were originally draft.
  }
}
