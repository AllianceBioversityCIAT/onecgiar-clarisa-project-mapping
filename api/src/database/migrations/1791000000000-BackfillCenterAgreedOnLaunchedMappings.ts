import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time data backfill of `project_mappings.center_agreed`.
 *
 * Background: launching a negotiation round (`openNegotiation` /
 * `startNegotiationRound`) and editing a draft allocation used to promote
 * mappings to `negotiating` WITHOUT setting `center_agreed = 1`, even though
 * the act of launching/editing is the center asserting its own proposal.
 * The projects-list turn indicator treats a `negotiating` mapping with
 * `center_agreed = 0` as "awaiting the center", so freshly-launched rounds
 * wrongly read as "needs my action" instead of "waiting for the program".
 * The service paths are fixed in the same release; this migration repairs
 * the rows the old logic produced.
 *
 * Scope (mirrors the diagnostic query): only `negotiating`, on an UNLOCKED
 * project, with `center_agreed = 0`, AND whose most recent negotiation event
 * was NOT a program-side action. The exclusion is the safety net: if a
 * program rep counter-proposed or requested removal last, `center_agreed = 0`
 * is genuinely the center's turn and must be left alone. (At authoring time
 * zero rows matched that exclusion, but it is enforced anyway so the backfill
 * stays correct against whatever the live data looks like when it runs.)
 *
 * `program_agreed` is intentionally NOT touched — these rows already carry
 * the program's true confirmation state, and the fixed launch paths only
 * force `program_agreed = 0` at the moment of launch, not retroactively.
 */
export class BackfillCenterAgreedOnLaunchedMappings1791000000000
  implements MigrationInterface
{
  name = 'BackfillCenterAgreedOnLaunchedMappings1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const result = await queryRunner.query(
      `UPDATE project_mappings m
         JOIN projects p ON p.id = m.project_id
         JOIN (
           SELECT n.mapping_id, n.actor_role, n.event_type
             FROM mapping_negotiations n
             JOIN (
               SELECT mapping_id, MAX(id) AS max_id
                 FROM mapping_negotiations
                GROUP BY mapping_id
             ) mx ON mx.mapping_id = n.mapping_id AND mx.max_id = n.id
         ) le ON le.mapping_id = m.id
          SET m.center_agreed = 1
        WHERE m.status = 'negotiating'
          AND m.center_agreed = 0
          AND p.negotiation_locked = 0
          AND NOT (
            le.actor_role = 'program_rep'
            AND le.event_type IN ('counter_proposed', 'removal_requested')
          )`,
    );

    const affected =
      (result as { affectedRows?: number })?.affectedRows ?? 'unknown';
    // eslint-disable-next-line no-console
    console.log(
      `[BackfillCenterAgreedOnLaunchedMappings] set center_agreed=1 on ${affected} mapping(s)`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible by design: the previous `center_agreed = 0` values were a
    // bug (the center had in fact asserted these terms by launching/editing),
    // so there is no meaningful prior state to restore. Intentionally a no-op.
  }
}
