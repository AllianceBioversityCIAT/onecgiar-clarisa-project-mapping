/**
 * Integration tests for ImportService.importProjectInfo() and
 * ImportService.importProjectBudgets().
 *
 * Calls the service methods directly (bypassing HTTP) so we can inspect
 * return summaries and query the DB for ground-truth assertions.
 *
 * Uses the real MySQL database. Budget rows inserted during tests are
 * keyed by external_code prefixed "FIXTURE-EXT-" and are cleaned up in
 * afterAll so the allocation invariant on project_mappings is preserved.
 */
import * as path from 'path';
import * as fs from 'fs';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ImportService } from '../src/modules/import/import.service';

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures');
const PROJECT_INFO_CSV = path.join(FIXTURE_DIR, 'project-info-sample.csv');
const PROJECT_BUDGET_CSV = path.join(FIXTURE_DIR, 'project-budget-sample.csv');

/** External codes written by the budget fixture — used for cleanup. */
const FIXTURE_EXTERNAL_CODES = [
  'FIXTURE-EXT-001',
  'FIXTURE-EXT-002',
  'FIXTURE-EXT-003',
  'FIXTURE-EXT-004',
  'FIXTURE-EXT-005',
];

describe('ImportService — integration (e2e)', () => {
  let app: INestApplication;
  let importService: ImportService;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    importService = app.get(ImportService);
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    /* Remove any budget lines written by the fixture CSV so repeated
     * test runs stay clean. */
    if (FIXTURE_EXTERNAL_CODES.length) {
      const placeholders = FIXTURE_EXTERNAL_CODES.map(() => '?').join(',');
      await dataSource.query(
        `DELETE FROM project_budgets WHERE external_code IN (${placeholders})`,
        FIXTURE_EXTERNAL_CODES,
      );
    }

    await app.close();
  });

  /* ------------------------------------------------------------------ */
  /* importProjectInfo()                                                 */
  /* ------------------------------------------------------------------ */

  describe('importProjectInfo()', () => {
    it('updates matched projects and skips unmatched rows', async () => {
      /* Snapshot mapping counts BEFORE import — must not change */
      const [{ cnt: mappingsBefore }]: [{ cnt: number }] =
        await dataSource.query(
          "SELECT COUNT(*) as cnt FROM project_mappings WHERE status != 'rejected'",
        );

      const summary = await importService.importProjectInfo(PROJECT_INFO_CSV);

      /* Fixture CSV has 4 data rows:
       *   S0003           → exists → matched + updated
       *   D-200394        → exists → matched + updated
       *   DOES-NOT-EXIST  → not in DB → skipped
       *   T-PJ-004023-VACS→ exists → matched + updated
       */
      expect(summary.matched).toBe(3);
      expect(summary.updated).toBe(3);
      expect(summary.skipped).toBe(1); // DOES-NOT-EXIST row
      expect(summary.errors).toHaveLength(0);

      /* Verify S0003 was actually updated in the DB */
      const [s0003]: [
        {
          nature_of_funder: string;
          category: string;
          csp: string;
          principal_investigator: string;
          total_pledge: string;
        },
      ] = await dataSource.query(
        'SELECT nature_of_funder, category, csp, principal_investigator, total_pledge FROM projects WHERE code = ?',
        ['S0003'],
      );

      expect(s0003.nature_of_funder).toBe('Foundation');
      expect(s0003.category).toBe('Restricted');
      expect(s0003.csp).toBe('YES');
      expect(s0003.principal_investigator).toBe('KREUZE JAN');
      expect(Number(s0003.total_pledge)).toBe(1200000);

      /* Verify T-PJ-004023-VACS was archived (Status=false in CSV) */
      const [vacs]: [{ status: string }] = await dataSource.query(
        'SELECT status FROM projects WHERE code = ?',
        ['T-PJ-004023-VACS'],
      );
      expect(vacs.status).toBe('archived');

      /* Allocation invariant: mapping counts must be unchanged */
      const [{ cnt: mappingsAfter }]: [{ cnt: number }] =
        await dataSource.query(
          "SELECT COUNT(*) as cnt FROM project_mappings WHERE status != 'rejected'",
        );
      expect(Number(mappingsAfter)).toBe(Number(mappingsBefore));
    });

    it('stores null for an unrecognized Nature of Funder value — no crash', async () => {
      /* Write a one-row CSV with a bogus Nature of Funder */
      const tmpCsv = path.join(FIXTURE_DIR, '_bad-nature.csv');
      fs.writeFileSync(
        tmpCsv,
        'Code,Funder,Funder of the Primary Center,Nature of Funder,Category,CSP,Reason for Non-collection of CSP,Total Pledge,Principal investigator,Signed Contract Title,Status\n' +
          'S0003,,,,COMPLETELY_INVALID_VALUE,,,,,,\n',
      );

      try {
        const summary = await importService.importProjectInfo(tmpCsv);
        expect(summary.errors).toHaveLength(0);

        /* The column should be null now (bad value is ignored) */
        const [row]: [{ nature_of_funder: string | null }] =
          await dataSource.query(
            'SELECT nature_of_funder FROM projects WHERE code = ?',
            ['S0003'],
          );
        /* validateEnum returns null for unrecognized values */
        expect(row.nature_of_funder).toBeNull();
      } finally {
        fs.unlinkSync(tmpCsv);
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* importProjectBudgets()                                              */
  /* ------------------------------------------------------------------ */

  describe('importProjectBudgets()', () => {
    it('first run inserts 4 lines (5th row skipped — unknown project)', async () => {
      /* Clean slate — remove any previous run */
      const placeholders = FIXTURE_EXTERNAL_CODES.map(() => '?').join(',');
      await dataSource.query(
        `DELETE FROM project_budgets WHERE external_code IN (${placeholders})`,
        FIXTURE_EXTERNAL_CODES,
      );

      const summary =
        await importService.importProjectBudgets(PROJECT_BUDGET_CSV);

      /* Fixture CSV: 5 rows, 1 skipped (DOES-NOT-EXIST project) */
      expect(summary.budgetLinesInserted).toBe(4);
      expect(summary.budgetLinesUpdated).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(summary.errors).toHaveLength(0);

      /* Verify two rows landed on S0003 */
      const [{ cnt }]: [{ cnt: number }] = await dataSource.query(
        "SELECT COUNT(*) as cnt FROM project_budgets WHERE external_code LIKE 'FIXTURE-EXT-00%' AND project_id = (SELECT id FROM projects WHERE code = 'S0003')",
      );
      expect(Number(cnt)).toBe(2);
    });

    it('second run on the same fixture is idempotent — 0 inserts, 4 updates', async () => {
      const summary =
        await importService.importProjectBudgets(PROJECT_BUDGET_CSV);

      expect(summary.budgetLinesInserted).toBe(0);
      expect(summary.budgetLinesUpdated).toBe(4);
      expect(summary.skipped).toBe(1);
      expect(summary.errors).toHaveLength(0);
    });

    it('allocation invariant preserved — mapping counts unchanged after budget import', async () => {
      const [{ cnt: before }]: [{ cnt: number }] = await dataSource.query(
        "SELECT COUNT(*) as cnt FROM project_mappings WHERE status != 'rejected'",
      );
      await importService.importProjectBudgets(PROJECT_BUDGET_CSV);
      const [{ cnt: after }]: [{ cnt: number }] = await dataSource.query(
        "SELECT COUNT(*) as cnt FROM project_mappings WHERE status != 'rejected'",
      );

      expect(Number(after)).toBe(Number(before));
    });

    it('budget rows are associated with the correct project IDs', async () => {
      const rows: Array<{ external_code: string; project_id: number }> =
        await dataSource.query(
          "SELECT external_code, project_id FROM project_budgets WHERE external_code LIKE 'FIXTURE-EXT-%' ORDER BY external_code",
        );

      const [s0003]: [{ id: number }] = await dataSource.query(
        'SELECT id FROM projects WHERE code = ?',
        ['S0003'],
      );
      const [d200394]: [{ id: number }] = await dataSource.query(
        'SELECT id FROM projects WHERE code = ?',
        ['D-200394'],
      );

      const byCode = Object.fromEntries(
        rows.map((r) => [r.external_code, r.project_id]),
      );

      expect(byCode['FIXTURE-EXT-001']).toBe(s0003.id);
      expect(byCode['FIXTURE-EXT-002']).toBe(s0003.id);
      expect(byCode['FIXTURE-EXT-003']).toBe(d200394.id);
      expect(byCode['FIXTURE-EXT-004']).toBe(d200394.id);
      /* FIXTURE-EXT-005 was skipped — no row */
      expect(byCode['FIXTURE-EXT-005']).toBeUndefined();
    });
  });
});
