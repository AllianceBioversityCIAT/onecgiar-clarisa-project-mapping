import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `programs.original_id` — MEL TOC graph UUID for each program.
 *
 * Why: the published-snapshot endpoint (`/api/toc/{officialCode}`)
 * serves a stale, frozen revision of each program's TOC graph
 * (e.g. SP01 v31 with 5 IOCs + 2 EOIs). The richer working-draft
 * payload — what Planning and other downstream tools consume — is
 * only reachable via `/api/toc/{UUID}`. `TocSyncService` prefers
 * this UUID when present and falls back to the official code when
 * it's null.
 *
 * Values are loaded via SQL from the Planning DB (where they live
 * as `initiatives.action_area_id`), not derived in code — keeping
 * the sync free of a discovery round-trip.
 *
 * Schema notes:
 *  - `varchar(36)` — UUID length; nullable so unmapped programs
 *    keep working against the official-code endpoint.
 *  - No FK — the column points at an upstream MEL TOC graph id,
 *    not at any local table.
 *  - Non-unique index — used as a lookup key during sync; UNIQUE
 *    would be wrong because the column is nullable by design and
 *    multiple unmapped programs can coexist with NULL.
 */
export class AddProgramOriginalId1786000000000 implements MigrationInterface {
  name = 'AddProgramOriginalId1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`programs\`
        ADD COLUMN \`original_id\` VARCHAR(36) NULL
    `);

    await queryRunner.query(`
      CREATE INDEX \`IDX_programs_original_id\`
        ON \`programs\` (\`original_id\`)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX \`IDX_programs_original_id\` ON \`programs\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`programs\` DROP COLUMN \`original_id\``,
    );
  }
}
