import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backfills the implicit-proposer-agreed invariant introduced with the new
 * negotiation flow: whoever posts a proposal (initiated / counter_proposed)
 * is treated as having agreed to that proposal. Without this backfill,
 * mappings where the counter-party already agreed were stuck in
 * `negotiating` because the proposer themselves never clicked Agree.
 *
 * For every negotiating mapping, look at the latest initiated /
 * counter_proposed event and mark the proposer's side as agreed. If both
 * sides end up agreed, the mapping transitions to `agreed`.
 */
export class ReconcileImplicitProposerAgreement1776187000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Mark center_agreed=true when the latest proposal was by a center rep.
    await queryRunner.query(`
      UPDATE project_mappings pm
      JOIN (
        SELECT mn.mapping_id, mn.actor_role
        FROM mapping_negotiations mn
        JOIN (
          SELECT mapping_id, MAX(id) AS max_id
          FROM mapping_negotiations
          WHERE event_type IN ('initiated', 'counter_proposed')
          GROUP BY mapping_id
        ) latest ON latest.mapping_id = mn.mapping_id AND latest.max_id = mn.id
      ) last_prop ON last_prop.mapping_id = pm.id
      SET pm.center_agreed = 1
      WHERE pm.status = 'negotiating' AND last_prop.actor_role = 'center_rep'
    `);

    // Same for program_rep proposers.
    await queryRunner.query(`
      UPDATE project_mappings pm
      JOIN (
        SELECT mn.mapping_id, mn.actor_role
        FROM mapping_negotiations mn
        JOIN (
          SELECT mapping_id, MAX(id) AS max_id
          FROM mapping_negotiations
          WHERE event_type IN ('initiated', 'counter_proposed')
          GROUP BY mapping_id
        ) latest ON latest.mapping_id = mn.mapping_id AND latest.max_id = mn.id
      ) last_prop ON last_prop.mapping_id = pm.id
      SET pm.program_agreed = 1
      WHERE pm.status = 'negotiating' AND last_prop.actor_role = 'program_rep'
    `);

    // Flip any now-both-agreed rows to status=agreed.
    await queryRunner.query(`
      UPDATE project_mappings
      SET status = 'agreed'
      WHERE status = 'negotiating' AND center_agreed = 1 AND program_agreed = 1
    `);
  }

  public async down(): Promise<void> {
    // No-op: cannot distinguish implicit backfill from genuine agreement.
  }
}
