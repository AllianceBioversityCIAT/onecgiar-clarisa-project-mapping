import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time repair of deadlocked `negotiating` mappings where BOTH agreement
 * flags are set.
 *
 * Background: `status = 'negotiating'` with `center_agreed = 1` AND
 * `program_agreed = 1` is an impossible state for the service layer —
 * `MappingsService.agree()` transitions to `agreed` the moment both flags are
 * true, always in the same transaction. Rows stuck like this make the turn
 * indicator read "awaiting the other side" for BOTH the center and the
 * program (`buildNegotiationTurnSelect`), so nobody ever sees "needs my
 * action" and the round deadlocks forever.
 *
 * How they got here: the May 2026 Signalling import (pre `e99cf09`) briefly
 * landed Increased/Decreased rows with both flags true while leaving the
 * mapping `negotiating`; later versions write `center_agreed = 0` /
 * `program_agreed = 1`. Separately, migration 1791 (backfill of
 * `center_agreed` on launched rounds) excluded rows whose last event was a
 * program-side counter-proposal — but the signalling seed events are authored
 * by the system user with `actor_role = 'admin'`, so its safety net did not
 * match and it re-set `center_agreed = 1` on repaired rows too.
 *
 * Repair: clear `center_agreed` so the row reads "awaiting the center's
 * response" — consistent with its thread, whose last substantive event is a
 * (program-side) `counter_proposed`. We deliberately do NOT flip these to
 * `agreed`: the center never actually consented, and doing so would bypass
 * the auto-lock and TOC-gate flows. Worst case after this repair, the center
 * re-confirms with a single agree click.
 *
 * Rows with an open removal request are excluded — those already correctly
 * read as the center's turn regardless of the flags.
 */
export class RepairDeadlockedNegotiatingMappings1796000000000 implements MigrationInterface {
  name = 'RepairDeadlockedNegotiatingMappings1796000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const result = await queryRunner.query(
      `UPDATE project_mappings
          SET center_agreed = 0
        WHERE status = 'negotiating'
          AND center_agreed = 1
          AND program_agreed = 1
          AND removal_requested = 0`,
    );

    const affected =
      (result as { affectedRows?: number })?.affectedRows ?? 'unknown';
    // eslint-disable-next-line no-console
    console.log(
      `[RepairDeadlockedNegotiatingMappings] cleared center_agreed on ${affected} deadlocked mapping(s)`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible by design: the prior both-flags-true state was invalid
    // (unreachable through the service layer) — there is nothing meaningful
    // to restore. Intentionally a no-op.
  }
}
