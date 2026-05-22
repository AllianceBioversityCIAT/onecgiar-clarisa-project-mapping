import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-country allocation %: switches `project_countries` (Location of
 * Benefit) and `project_implementation_countries` (Country of
 * Implementation) from plain M2M junctions to junction entities that
 * carry an `allocation_percentage decimal(5,2)`.
 *
 * Also replaces the single `projects.is_global` boolean with two
 * independent per-table flags (`is_benefit_global`,
 * `is_implementation_global`) so each list can be marked Global
 * separately. The old `is_global` value seeds the new
 * `is_benefit_global` (legacy semantics — `is_global` only ever
 * affected the Location of Benefit list).
 *
 * Backfill: existing rows on both junctions are distributed evenly
 * (`100 / count` per row, rounded to 2 dp; the last row absorbs any
 * rounding residue so each project's allocations still sum to 100).
 * The sum-≤-100 / each-row-> 0 invariants are enforced at the service
 * layer, not in DB.
 */
export class AddCountryAllocations1784000000000 implements MigrationInterface {
  name = 'AddCountryAllocations1784000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /* 1. Add allocation_percentage to both junction tables. NULL during
     *    the backfill, then NOT NULL once distributed. */
    await queryRunner.query(`
      ALTER TABLE \`project_countries\`
        ADD COLUMN \`allocation_percentage\` DECIMAL(5,2) NULL
        AFTER \`country_id\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_implementation_countries\`
        ADD COLUMN \`allocation_percentage\` DECIMAL(5,2) NULL
        AFTER \`country_id\`
    `);

    /* 2. Add the two per-table Global flags, seeded from is_global so
     *    the Location-of-Benefit semantics survive the rename. */
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD COLUMN \`is_benefit_global\` BOOLEAN NOT NULL DEFAULT false
        AFTER \`is_global\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD COLUMN \`is_implementation_global\` BOOLEAN NOT NULL DEFAULT false
        AFTER \`is_benefit_global\`
    `);
    await queryRunner.query(`
      UPDATE \`projects\` SET \`is_benefit_global\` = \`is_global\`
    `);

    /* 3. Backfill allocations: distribute 100 / N evenly across each
     *    project's rows. The last row (highest country_id) gets the
     *    rounding residue so the project sums to exactly 100.
     *
     *    We compute base = FLOOR(100 / N * 100) / 100 for non-last
     *    rows and residue = 100 - base * (N - 1) for the last row.
     *    Two UPDATEs per table — one for non-last rows, one for the
     *    per-project last row. */
    for (const table of [
      'project_countries',
      'project_implementation_countries',
    ]) {
      /* Non-last rows: base = ROUND(100/N, 2). */
      await queryRunner.query(`
        UPDATE \`${table}\` t
        JOIN (
          SELECT project_id,
                 COUNT(*) AS n,
                 MAX(country_id) AS last_country_id
            FROM \`${table}\`
           GROUP BY project_id
        ) s ON s.project_id = t.project_id
        SET t.allocation_percentage = ROUND(100 / s.n, 2)
        WHERE t.country_id <> s.last_country_id
      `);
      /* Last row per project: 100 - sum(non-last). */
      await queryRunner.query(`
        UPDATE \`${table}\` t
        JOIN (
          SELECT project_id,
                 MAX(country_id) AS last_country_id,
                 COUNT(*) AS n
            FROM \`${table}\`
           GROUP BY project_id
        ) s ON s.project_id = t.project_id AND s.last_country_id = t.country_id
        SET t.allocation_percentage = ROUND(100 - ROUND(100 / s.n, 2) * (s.n - 1), 2)
      `);
    }

    /* 4. Tighten the allocation column to NOT NULL now that backfill
     *    has populated every existing row. */
    await queryRunner.query(`
      ALTER TABLE \`project_countries\`
        MODIFY COLUMN \`allocation_percentage\` DECIMAL(5,2) NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_implementation_countries\`
        MODIFY COLUMN \`allocation_percentage\` DECIMAL(5,2) NOT NULL
    `);

    /* 5. Drop the legacy single is_global column. is_benefit_global
     *    now carries that meaning. */
    await queryRunner.query(`
      ALTER TABLE \`projects\` DROP COLUMN \`is_global\`
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /* Restore is_global from is_benefit_global so the legacy column
     * keeps its semantics. */
    await queryRunner.query(`
      ALTER TABLE \`projects\`
        ADD COLUMN \`is_global\` BOOLEAN NOT NULL DEFAULT false
        AFTER \`negotiation_locked\`
    `);
    await queryRunner.query(`
      UPDATE \`projects\` SET \`is_global\` = \`is_benefit_global\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`projects\` DROP COLUMN \`is_implementation_global\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`projects\` DROP COLUMN \`is_benefit_global\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_implementation_countries\`
        DROP COLUMN \`allocation_percentage\`
    `);
    await queryRunner.query(`
      ALTER TABLE \`project_countries\`
        DROP COLUMN \`allocation_percentage\`
    `);
  }
}
