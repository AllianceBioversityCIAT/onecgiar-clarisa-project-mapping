import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time data cleanup of false-positive field diffs in `audit_events`.
 *
 * Background: `ProjectsService.applyEdits()` strict-compared the
 * DB-hydrated entity against the incoming DTO. TypeORM hydrates
 * decimal(10,2) columns as strings ("380351.00") while DTOs carry
 * numbers (380351), so `totalBudget` / `remainingBudget` were recorded
 * as "changed" on every project save even when untouched. The same
 * comparison also treated a NULL column vs an empty-string form value
 * as a change on nullable text fields. The diff logic is fixed in the
 * same release; this migration prunes the rows the old logic produced.
 *
 * Per affected `project.update` / `project.metadata_update` row:
 *  - drop `totalBudget` / `remainingBudget` keys whose before/after are
 *    numerically equal (e.g. "380351.00" → 380351);
 *  - drop nullable-text keys where both sides are empty
 *    (null / '' / whitespace-only), i.e. the null → "" artefact;
 *  - if a real change survives, rewrite `changes` with the false keys
 *    removed and refresh the "Edited …: field, field" summary;
 *  - if nothing survives, DELETE the row — it never represented a
 *    change. (audit_events is append-only by convention; this targeted
 *    deletion of provably-false rows is a deliberate, approved
 *    exception.)
 *
 * Rows are processed in JS (not pure SQL) because the per-key decimal
 * comparison and summary rebuild are awkward to express in MySQL JSON
 * functions, and the affected row count is small (tens of rows).
 */
export class PruneFalsePositiveProjectAuditChanges1790000000000 implements MigrationInterface {
  name = 'PruneFalsePositiveProjectAuditChanges1790000000000';

  /** Money fields the old diff flagged due to string-vs-number typing. */
  private static readonly DECIMAL_FIELDS = ['totalBudget', 'remainingBudget'];

  /** Nullable text fields where null vs '' was recorded as a change. */
  private static readonly NULLABLE_TEXT_FIELDS = [
    'description',
    'summary',
    'fundingSource',
    'funder',
    'principalInvestigator',
    'email',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{
      id: number;
      action: string;
      changes: unknown;
      summary: string | null;
    }> = await queryRunner.query(
      `SELECT id, action, changes, summary
         FROM audit_events
        WHERE entity_type = 'project'
          AND action IN ('project.update', 'project.metadata_update')
          AND changes IS NOT NULL`,
    );

    for (const row of rows) {
      // mysql2 may hand JSON columns back as parsed objects or strings
      // depending on driver settings — normalise to an object.
      const changes: Record<string, { before: unknown; after: unknown }> =
        typeof row.changes === 'string'
          ? JSON.parse(row.changes)
          : (row.changes as Record<
              string,
              { before: unknown; after: unknown }
            >);

      if (!changes || typeof changes !== 'object') continue;

      const kept: Record<string, { before: unknown; after: unknown }> = {};
      let droppedAny = false;

      for (const [field, pair] of Object.entries(changes)) {
        // Defensive: keep any entry that isn't the expected
        // { before, after } object shape rather than crash on it.
        if (!pair || typeof pair !== 'object' || Array.isArray(pair)) {
          kept[field] = pair;
          continue;
        }
        if (this.isFalsePositive(field, pair)) {
          droppedAny = true;
        } else {
          kept[field] = pair;
        }
      }

      if (!droppedAny) continue;

      const keptFields = Object.keys(kept);
      if (keptFields.length === 0) {
        // Every "change" on the row was a false positive — the edit
        // never happened. Remove the row entirely.
        await queryRunner.query(`DELETE FROM audit_events WHERE id = ?`, [
          row.id,
        ]);
        continue;
      }

      // Real changes survive: rewrite the payload without the false
      // keys and refresh the auto-generated field-list summary so the
      // UI no longer names fields that did not change. Free-text
      // summaries (anything not matching the generated prefix) are
      // left untouched.
      const prefix =
        row.action === 'project.metadata_update'
          ? 'Edited metadata: '
          : 'Edited project: ';
      const newSummary =
        row.summary && row.summary.startsWith(prefix)
          ? `${prefix}${keptFields.join(', ')}`
          : row.summary;

      await queryRunner.query(
        `UPDATE audit_events SET changes = ?, summary = ? WHERE id = ?`,
        [JSON.stringify(kept), newSummary, row.id],
      );
    }
  }

  /** True when the before/after pair is one of the known false-positive shapes. */
  private isFalsePositive(
    field: string,
    pair: { before: unknown; after: unknown },
  ): boolean {
    const cls = PruneFalsePositiveProjectAuditChanges1790000000000;

    if (cls.DECIMAL_FIELDS.includes(field)) {
      const before = this.toCanonicalDecimal(pair.before);
      const after = this.toCanonicalDecimal(pair.after);
      return before === after;
    }

    if (cls.NULLABLE_TEXT_FIELDS.includes(field)) {
      return this.isEmptyText(pair.before) && this.isEmptyText(pair.after);
    }

    return false;
  }

  /** Mirrors ProjectsService.toCanonicalDecimal for the cleanup pass. */
  private toCanonicalDecimal(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(2) : String(value);
  }

  /** null / '' / whitespace-only all count as "no value". */
  private isEmptyText(value: unknown): boolean {
    return (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')
    );
  }

  public async down(): Promise<void> {
    // Irreversible by design: the pruned keys and deleted rows were
    // false positives produced by a comparison bug — there is nothing
    // meaningful to restore. Intentionally a no-op.
  }
}
