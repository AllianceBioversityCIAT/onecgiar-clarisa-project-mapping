import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time repair of stale `needs_assistance` flags left on `removed`
 * mappings.
 *
 * Background: `needs_assistance` is auto-set after a program rep's 2nd
 * counter-proposal and is only ever cleared by the three resolution paths
 * that flip a mapping to `agreed` (`MappingsService.agree()`,
 * `rebalanceAndAgree()`, `finalDecision()`). `removeProgram()` — the
 * center-side "remove a mapping" action — transitioned a flagged mapping
 * straight to `removed` without clearing the flag. Because the "Needs
 * Assistance" list/dashboard filter (`NEEDS_ASSISTANCE_SQL` in
 * `projects.service.ts`) had no status exclusion, a single removed mapping
 * with a stale flag kept surfacing its whole project under "Needs
 * Assistance" forever — even after every remaining mapping was agreed and
 * the round locked. See GitHub issue #109.
 *
 * The application-code leak is fixed alongside this migration:
 * `removeProgram()` now clears `needsAssistance`/`flaggedAt` on removal,
 * and `NEEDS_ASSISTANCE_SQL` now excludes `removed` rows as defense in
 * depth. This migration only repairs the (currently two) already-stale
 * rows in production data.
 */
export class ClearStaleNeedsAssistanceOnRemovedMappings1797000000000 implements MigrationInterface {
  name = 'ClearStaleNeedsAssistanceOnRemovedMappings1797000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const result = await queryRunner.query(
      `UPDATE project_mappings
          SET needs_assistance = 0, flagged_at = NULL
        WHERE needs_assistance = 1
          AND status = 'removed'`,
    );

    const affected =
      (result as { affectedRows?: number })?.affectedRows ?? 'unknown';
    // eslint-disable-next-line no-console
    console.log(
      `[ClearStaleNeedsAssistanceOnRemovedMappings] cleared needs_assistance on ${affected} stale removed mapping(s)`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible by design: the prior stale-flagged state was itself a
    // bug (a removed mapping should never carry an active arbitration
    // flag) — there is nothing meaningful to restore. Intentionally a
    // no-op.
  }
}
