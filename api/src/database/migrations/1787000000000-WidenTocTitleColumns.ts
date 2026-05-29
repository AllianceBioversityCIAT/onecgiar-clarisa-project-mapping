import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widen `toc_outcomes.title` and `toc_outputs.title` from `varchar(500)`
 * to `varchar(1000)`.
 *
 * The published-snapshot TOC payloads kept node titles short (≤ 350
 * chars in practice). The working-draft payloads — what `TocSyncService`
 * now fetches whenever `programs.original_id` is set — include
 * paragraph-length EOI titles (SP04 has one at 597 chars), causing
 * `ER_DATA_TOO_LONG` errors at sync time. `varchar(1000)` covers the
 * current max with comfortable headroom; bumping further would push
 * past the InnoDB index-key prefix limit for some collations.
 *
 * Widening a VARCHAR in MySQL is an in-place metadata change for
 * tables under ~16 million rows (these tables are in the low
 * thousands), so this is fast and lock-light. No data is touched —
 * existing rows are valid against the new constraint.
 *
 * `down()` narrows back to varchar(500). Reverting could fail if any
 * row was written with a >500-char title since the up — that's the
 * inherent risk of narrowing and is acceptable for a manual rollback
 * (run after pruning oversized rows if needed).
 */
export class WidenTocTitleColumns1787000000000 implements MigrationInterface {
  name = 'WidenTocTitleColumns1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`toc_outcomes\`
        MODIFY COLUMN \`title\` VARCHAR(1000) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE \`toc_outputs\`
        MODIFY COLUMN \`title\` VARCHAR(1000) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /* Refuse to narrow if any row would be silently truncated.
     * Matches the precedent set by `1776300400000-WidenPublishedProjectName`:
     * the operator must prune oversized rows themselves before re-running. */
    for (const table of ['toc_outcomes', 'toc_outputs']) {
      const rows: Array<{ count: string | number }> = await queryRunner.query(
        `SELECT COUNT(*) AS \`count\` FROM \`${table}\` WHERE CHAR_LENGTH(\`title\`) > 500`,
      );
      const count = Number(rows?.[0]?.count ?? 0);
      if (count > 0) {
        throw new Error(
          `Cannot narrow ${table}.title to varchar(500): ${count} row(s) exceed 500 chars. Prune or truncate them first.`,
        );
      }
    }

    await queryRunner.query(`
      ALTER TABLE \`toc_outcomes\`
        MODIFY COLUMN \`title\` VARCHAR(500) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE \`toc_outputs\`
        MODIFY COLUMN \`title\` VARCHAR(500) NULL
    `);
  }
}
