import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time data fix: correct the `projects.funder` (donor) name on three
 * projects whose Mapping Module value was wrong or missing.
 *
 *   Code      | Was                                  | Now
 *   ----------|--------------------------------------|--------------------------------------------------------------------
 *   W-D-0392  | ADB-Asian Development Bank           | Government of Netherlands / Directorate-General for International Cooperation (DGIS)
 *   W-D-0424  | BMGF-Bill & Melinda Gates Foundation | Foreign, Commonwealth & Development Office (FCDO)
 *   W-D-0594  | (null — no funder info)              | Department of Foreign Affairs and Trade (DFAT), Australia
 *
 * `funder` is normally an Anaplan-sourced field (only CSV import overwrites it),
 * but these specific rows carried incorrect data, so this migration patches them
 * directly. Each UPDATE is guarded by the known prior value so a re-run or a row
 * already corrected by a later import is left untouched.
 */
export class CorrectFunderNamesOnThreeProjects1792000000000
  implements MigrationInterface
{
  name = 'CorrectFunderNamesOnThreeProjects1792000000000';

  private readonly corrections = [
    {
      code: 'W-D-0392',
      from: 'ADB-Asian Development Bank',
      to: 'Government of Netherlands / Directorate-General for International Cooperation (DGIS)',
    },
    {
      code: 'W-D-0424',
      from: 'BMGF-Bill & Melinda Gates Foundation',
      to: 'Foreign, Commonwealth & Development Office (FCDO)',
    },
    {
      code: 'W-D-0594',
      from: null,
      to: 'Department of Foreign Affairs and Trade (DFAT), Australia',
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.apply(queryRunner, 'to', 'from');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.apply(queryRunner, 'from', 'to');
  }

  /** Set `funder` to `target` only where it currently equals `expected`. */
  private async apply(
    queryRunner: QueryRunner,
    targetKey: 'from' | 'to',
    expectedKey: 'from' | 'to',
  ): Promise<void> {
    for (const c of this.corrections) {
      const target = c[targetKey];
      const expected = c[expectedKey];
      const guard =
        expected === null ? 'funder IS NULL' : 'funder = ?';
      const params = expected === null ? [target, c.code] : [target, c.code, expected];
      await queryRunner.query(
        `UPDATE projects SET funder = ? WHERE code = ? AND ${guard}`,
        params,
      );
    }
  }
}
