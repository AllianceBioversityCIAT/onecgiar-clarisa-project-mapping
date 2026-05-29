import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Many-to-many junction `toc_outcome_aows` between `toc_outcomes`
 * and `toc_aows`.
 *
 * Why: a TOC outcome can legitimately belong to multiple AOWs.
 * The current `toc_outcomes.aow_id` single FK is populated from the
 * outcome node's `group` field, but for several programs (SP01, SP07,
 * SP10 entirely; partial on others) outcomes carry an empty `group`
 * and the parent AOW(s) are only discoverable by traversing the
 * `relations[]` graph (inbound LINK edges from OUTPUT nodes whose
 * own `group` IS the AOW). The TOC Contribution picker depends on
 * this mapping, so we need real multi-parent support.
 *
 * Schema notes:
 *  - Composite PK `(outcome_id, aow_id)` — both columns NOT NULL,
 *    duplicates impossible.
 *  - Both FKs `ON DELETE CASCADE` so a delete on either parent
 *    purges the junction row in one shot (no orphans).
 *  - Reverse-lookup index on `aow_id` so the "which outcomes belong
 *    to this AOW?" query stays cheap as the table grows.
 *
 * Backfill: copy every `(id, aow_id)` from `toc_outcomes` where
 * `aow_id IS NOT NULL` so existing single-AOW mappings continue to
 * resolve without re-running a full TOC sync. The legacy scalar
 * column is intentionally left in place — the sync service keeps
 * writing it (set to the first AOW in the union) so any code still
 * reading it doesn't break, and we retain a rollback target.
 */
export class AddTocOutcomeAowsJunction1785000000000 implements MigrationInterface {
  name = 'AddTocOutcomeAowsJunction1785000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE \`toc_outcome_aows\` (
        \`outcome_id\` int NOT NULL,
        \`aow_id\` int NOT NULL,
        PRIMARY KEY (\`outcome_id\`, \`aow_id\`),
        INDEX \`IDX_toc_outcome_aows_aow\` (\`aow_id\`),
        CONSTRAINT \`FK_toc_outcome_aows_outcome\` FOREIGN KEY (\`outcome_id\`)
          REFERENCES \`toc_outcomes\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT \`FK_toc_outcome_aows_aow\` FOREIGN KEY (\`aow_id\`)
          REFERENCES \`toc_aows\` (\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);

    /* Seed from the existing scalar FK so the picker doesn't regress
     * before the next TOC sync repopulates the junction with unions. */
    await queryRunner.query(`
      INSERT INTO \`toc_outcome_aows\` (\`outcome_id\`, \`aow_id\`)
      SELECT \`id\`, \`aow_id\`
        FROM \`toc_outcomes\`
       WHERE \`aow_id\` IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE \`toc_outcome_aows\``);
  }
}
