/**
 * E2E integration tests for POST /admin/sync-toc.
 *
 * Uses the real MySQL database. TocService.fetchProgram is stubbed via
 * jest.spyOn so no real TOC API calls are made.
 *
 * Test isolation:
 *  - A dedicated program row is inserted in beforeAll with a unique
 *    clarisa_id to avoid colliding with seeded CLARISA data.
 *  - All toc_aows / toc_outputs / toc_outcomes rows for that program
 *    are deleted in afterAll.
 *  - The program row itself is also deleted.
 *
 * Assertions cover:
 *  - HTTP 201 + body shape on first sync
 *  - DB row counts per table
 *  - FK resolution: output.aow_id and outcome.aow_id point to the
 *    correct toc_aows row
 *  - Idempotency: second call leaves row counts unchanged
 *  - 403 when called as a non-admin (program_rep)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { TocService } from '../src/modules/toc/toc.service';
import { UserRole } from '../src/modules/users/enums/user-role.enum';
import { TocApiResponse } from '../src/modules/toc/interfaces';

/* ═══════════════════════════════════════════════════════════════
   Constants
   ══════════════════════════════════════════════════════════════ */

/** Synthetic program used only for this test suite. */
const TEST_PROGRAM_CODE = 'TOC-E2E-SP99';
/** clarisa_id must not collide with real seeded rows (use a high value). */
const TEST_CLARISA_ID = 999_001;
const TEST_PROGRAM_NAME = 'TOC E2E Test Program';

const ADMIN_EMAIL = 'admin@codeobia.com';
const PROGRAM_REP_EMAIL = 'toc-e2e-program@codeobia.com';

/* ═══════════════════════════════════════════════════════════════
   Fixture TOC response
   ══════════════════════════════════════════════════════════════ */

/**
 * Builds the stubbed TOC API response for the test program.
 *
 * Layout:
 *  - 2 AOWs
 *    - AOW-A: id='WP-A', related_node_id='WP-A-NODE'
 *    - AOW-B: id='WP-B', related_node_id=null  (falls back to 'WP-B')
 *  - 3 Outputs
 *    - OUT-1: group='WP-A'  → resolves to AOW-A (tests raw WP.id key)
 *    - OUT-2: group='WP-B'  → resolves to AOW-B
 *    - OUT-3: group=''      → aow_id = null
 *  - 2 Outcomes
 *    - OC-1: category=OUTCOME, group='WP-A'  → intermediate, FK to AOW-A
 *    - OC-2: category=EOI,     group=null    → portfolio, aow_id = null
 */
function buildFixtureResponse(): TocApiResponse {
  return {
    data: [
      /* AOW-A: related_node_id differs from id — exercises the FK trap */
      {
        id: 'WP-A',
        category: 'WP',
        wp_type: 'AOW',
        title: 'AOW Alpha Title',
        related_node_id: 'WP-A-NODE',
        ost_wp: {
          toc_id: 'CLARISA-TOC-A',
          acronym: 'AOW-A',
          wp_official_code: 'SP99-AOW-A',
          name: 'Alpha Area of Work',
        },
      },
      /* AOW-B: no related_node_id — node_id = raw id */
      {
        id: 'WP-B',
        category: 'WP',
        wp_type: 'AOW',
        title: 'AOW Beta Title',
        related_node_id: null,
        ost_wp: {
          toc_id: null,
          acronym: 'AOW-B',
          wp_official_code: 'SP99-AOW-B',
          name: 'Beta Area of Work',
        },
      },
      /* Output 1: group references raw WP.id='WP-A', not derived 'WP-A-NODE' */
      {
        id: 'OUT-1',
        category: 'OUTPUT',
        title: 'Output One',
        description: 'First output description',
        type_of_output: 'Knowledge product',
        group: 'WP-A',
        related_node_id: 'OUT-1-NODE',
      },
      /* Output 2: group references WP-B (id = derived node_id here) */
      {
        id: 'OUT-2',
        category: 'OUTPUT',
        title: 'Output Two',
        description: null,
        type_of_output: null,
        group: 'WP-B',
        related_node_id: null,
      },
      /* Output 3: empty group → aow_id = null */
      {
        id: 'OUT-3',
        category: 'OUTPUT',
        title: 'Output Three',
        description: null,
        type_of_output: null,
        group: '',
        related_node_id: null,
      },
      /* Outcome 1: intermediate, group references WP-A */
      {
        id: 'OC-1',
        category: 'OUTCOME',
        title: 'Intermediate Outcome One',
        description: 'Outcome description',
        group: 'WP-A',
        related_node_id: null,
      },
      /* Outcome 2: portfolio (EOI), no group → aow_id = null */
      {
        id: 'OC-2',
        category: 'EOI',
        title: 'Portfolio Outcome One',
        description: null,
        group: null,
        related_node_id: null,
      },
    ],
  };
}

/* ═══════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════ */

async function getToken(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .get(`/api/auth/dev-token?email=${encodeURIComponent(email)}`)
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

async function ensureRole(
  ds: DataSource,
  email: string,
  role: UserRole,
  programId: number | null,
): Promise<void> {
  await ds.query(
    `UPDATE users SET role = ?, program_id = ?, is_active = 1 WHERE email = ?`,
    [role, programId, email],
  );
}

/* ═══════════════════════════════════════════════════════════════
   Suite
   ══════════════════════════════════════════════════════════════ */

describe('POST /admin/sync-toc — integration (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let tocService: TocService;
  let adminToken: string;
  let programRepToken: string;
  let testProgramId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    ds = app.get(DataSource);
    tocService = app.get(TocService);

    /* Stub fetchProgram — must be done before any request so the spy is
     * in place for the controller call. Return null by default; each
     * test that needs a real response overrides it. */
    jest.spyOn(tocService, 'fetchProgram').mockResolvedValue(null);

    /* Seed the test program. Use INSERT IGNORE so re-runs don't fail. */
    await ds.query(
      `INSERT IGNORE INTO programs (clarisa_id, official_code, name, synced_at)
       VALUES (?, ?, ?, NOW())`,
      [TEST_CLARISA_ID, TEST_PROGRAM_CODE, TEST_PROGRAM_NAME],
    );
    const [row] = await ds.query<{ id: number }[]>(
      `SELECT id FROM programs WHERE clarisa_id = ?`,
      [TEST_CLARISA_ID],
    );
    testProgramId = row.id;

    /* Bootstrap auth tokens. */
    adminToken = await getToken(app, ADMIN_EMAIL);
    programRepToken = await getToken(app, PROGRAM_REP_EMAIL);
    await ensureRole(ds, PROGRAM_REP_EMAIL, UserRole.PROGRAM_REP, null);
    /* Re-issue so the JWT payload reflects the new role. */
    programRepToken = await getToken(app, PROGRAM_REP_EMAIL);
  });

  afterAll(async () => {
    /* Delete TOC rows for the test program (FK order: outputs/outcomes first,
     * then aows, then the program itself). */
    await ds.query(`DELETE FROM toc_outputs  WHERE program_id = ?`, [
      testProgramId,
    ]);
    await ds.query(`DELETE FROM toc_outcomes WHERE program_id = ?`, [
      testProgramId,
    ]);
    await ds.query(`DELETE FROM toc_aows     WHERE program_id = ?`, [
      testProgramId,
    ]);
    await ds.query(`DELETE FROM programs     WHERE clarisa_id = ?`, [
      TEST_CLARISA_ID,
    ]);

    /* Demote test user. */
    await ds.query(
      `UPDATE users SET role = NULL, program_id = NULL WHERE email = ?`,
      [PROGRAM_REP_EMAIL],
    );

    jest.restoreAllMocks();
    await app.close();
  });

  beforeEach(async () => {
    /* Reset the stub to null before each test so tests that don't override
     * it don't accidentally receive stale fixture data. */
    (tocService.fetchProgram as jest.Mock).mockResolvedValue(null);
  });

  /* ── RBAC ───────────────────────────────────────────────── */

  it('returns 403 when called as a program_rep', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/sync-toc')
      .set('Authorization', `Bearer ${programRepToken}`)
      .expect(403);
  });

  it('returns 401 when called without auth', async () => {
    await request(app.getHttpServer()).post('/api/admin/sync-toc').expect(401);
  });

  /* ── Happy path — first sync ────────────────────────────── */

  describe('first sync with fixture data', () => {
    let syncBody: {
      synced: number;
      failed: number;
      details: Array<{
        programCode: string;
        aows?: number;
        outputs?: number;
        outcomes?: number;
        error?: string;
      }>;
    };

    beforeAll(async () => {
      /* Wipe any prior TOC rows for this program so the count assertions
       * are unambiguous regardless of run order. */
      await ds.query(`DELETE FROM toc_outputs  WHERE program_id = ?`, [
        testProgramId,
      ]);
      await ds.query(`DELETE FROM toc_outcomes WHERE program_id = ?`, [
        testProgramId,
      ]);
      await ds.query(`DELETE FROM toc_aows     WHERE program_id = ?`, [
        testProgramId,
      ]);

      /* Stub so only our test program returns fixture data; all others
       * in the programs table get null (404 path). */
      (tocService.fetchProgram as jest.Mock).mockImplementation(
        async (code: string) => {
          if (code === TEST_PROGRAM_CODE) return buildFixtureResponse();
          return null;
        },
      );

      const res = await request(app.getHttpServer())
        .post('/api/admin/sync-toc')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);

      syncBody = res.body as typeof syncBody;
    });

    it('returns HTTP 201', () => {
      /* already asserted in beforeAll via .expect(201), but explicit: */
      expect(syncBody).toBeDefined();
    });

    it('response body contains synced ≥ 1 and failed ≥ 0', () => {
      expect(syncBody.synced).toBeGreaterThanOrEqual(1);
      expect(syncBody.failed).toBeGreaterThanOrEqual(0);
      expect(typeof syncBody.failed).toBe('number');
    });

    it('response body details includes SP99 with correct counts', () => {
      const sp99 = syncBody.details.find(
        (d) => d.programCode === TEST_PROGRAM_CODE,
      );
      expect(sp99).toBeDefined();
      expect(sp99).toMatchObject({
        programCode: TEST_PROGRAM_CODE,
        aows: 2,
        outputs: 3,
        outcomes: 2,
      });
      expect(sp99?.error).toBeUndefined();
    });

    it('inserts exactly 2 toc_aows rows for the test program', async () => {
      const [{ cnt }] = await ds.query<{ cnt: string }[]>(
        `SELECT COUNT(*) AS cnt FROM toc_aows WHERE program_id = ?`,
        [testProgramId],
      );
      expect(Number(cnt)).toBe(2);
    });

    it('inserts exactly 3 toc_outputs rows for the test program', async () => {
      const [{ cnt }] = await ds.query<{ cnt: string }[]>(
        `SELECT COUNT(*) AS cnt FROM toc_outputs WHERE program_id = ?`,
        [testProgramId],
      );
      expect(Number(cnt)).toBe(3);
    });

    it('inserts exactly 2 toc_outcomes rows for the test program', async () => {
      const [{ cnt }] = await ds.query<{ cnt: string }[]>(
        `SELECT COUNT(*) AS cnt FROM toc_outcomes WHERE program_id = ?`,
        [testProgramId],
      );
      expect(Number(cnt)).toBe(2);
    });

    it('resolves AOW-A node_id from related_node_id (WP-A-NODE, not WP-A)', async () => {
      const rows = await ds.query<{ node_id: string }[]>(
        `SELECT node_id FROM toc_aows WHERE program_id = ? AND acronym = 'AOW-A'`,
        [testProgramId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].node_id).toBe('WP-A-NODE');
    });

    it('resolves AOW-B node_id to raw id (WP-B) when related_node_id is null', async () => {
      const rows = await ds.query<{ node_id: string }[]>(
        `SELECT node_id FROM toc_aows WHERE program_id = ? AND acronym = 'AOW-B'`,
        [testProgramId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].node_id).toBe('WP-B');
    });

    it('Output OUT-1 FK resolves to AOW-A (keyed by raw WP.id WP-A, not WP-A-NODE)', async () => {
      /* Fetch the DB id for AOW-A (stored as node_id='WP-A-NODE'). */
      const [aowRow] = await ds.query<{ id: number }[]>(
        `SELECT id FROM toc_aows WHERE program_id = ? AND node_id = 'WP-A-NODE'`,
        [testProgramId],
      );
      expect(aowRow).toBeDefined();

      /* OUT-1 has related_node_id='OUT-1-NODE' so node_id='OUT-1-NODE'. */
      const [outRow] = await ds.query<{ aow_id: number | null }[]>(
        `SELECT aow_id FROM toc_outputs WHERE program_id = ? AND node_id = 'OUT-1-NODE'`,
        [testProgramId],
      );
      expect(outRow).toBeDefined();
      expect(outRow.aow_id).toBe(aowRow.id);
    });

    it('Output OUT-3 has aow_id=null (empty group)', async () => {
      /* OUT-3 has no related_node_id so node_id='OUT-3'. */
      const [outRow] = await ds.query<{ aow_id: number | null }[]>(
        `SELECT aow_id FROM toc_outputs WHERE program_id = ? AND node_id = 'OUT-3'`,
        [testProgramId],
      );
      expect(outRow).toBeDefined();
      expect(outRow.aow_id).toBeNull();
    });

    it('Outcome OC-1 is intermediate and FKs to AOW-A', async () => {
      const [aowRow] = await ds.query<{ id: number }[]>(
        `SELECT id FROM toc_aows WHERE program_id = ? AND node_id = 'WP-A-NODE'`,
        [testProgramId],
      );

      /* OC-1 has no related_node_id, so node_id='OC-1'. */
      const [ocRow] = await ds.query<
        { outcome_type: string; aow_id: number | null }[]
      >(
        `SELECT outcome_type, aow_id FROM toc_outcomes WHERE program_id = ? AND node_id = 'OC-1'`,
        [testProgramId],
      );
      expect(ocRow).toBeDefined();
      expect(ocRow.outcome_type).toBe('intermediate');
      expect(ocRow.aow_id).toBe(aowRow.id);
    });

    it('Outcome OC-2 is portfolio and has aow_id=null (null group)', async () => {
      const [ocRow] = await ds.query<
        { outcome_type: string; aow_id: number | null }[]
      >(
        `SELECT outcome_type, aow_id FROM toc_outcomes WHERE program_id = ? AND node_id = 'OC-2'`,
        [testProgramId],
      );
      expect(ocRow).toBeDefined();
      expect(ocRow.outcome_type).toBe('portfolio');
      expect(ocRow.aow_id).toBeNull();
    });

    it('AOW-A stores ost_wp metadata correctly', async () => {
      const [aow] = await ds.query<
        {
          clarisa_toc_id: string | null;
          acronym: string | null;
          wp_official_code: string | null;
          name: string | null;
        }[]
      >(
        `SELECT clarisa_toc_id, acronym, wp_official_code, name
           FROM toc_aows WHERE program_id = ? AND node_id = 'WP-A-NODE'`,
        [testProgramId],
      );
      expect(aow.clarisa_toc_id).toBe('CLARISA-TOC-A');
      expect(aow.acronym).toBe('AOW-A');
      expect(aow.wp_official_code).toBe('SP99-AOW-A');
      expect(aow.name).toBe('Alpha Area of Work');
    });
  });

  /* ── Idempotency — second sync ──────────────────────────── */

  describe('second sync (idempotency)', () => {
    let countsBefore: { aows: number; outputs: number; outcomes: number };
    let countAfter: { aows: number; outputs: number; outcomes: number };

    beforeAll(async () => {
      /* Ensure rows exist from a first sync. */
      (tocService.fetchProgram as jest.Mock).mockImplementation(
        async (code: string) => {
          if (code === TEST_PROGRAM_CODE) return buildFixtureResponse();
          return null;
        },
      );

      await request(app.getHttpServer())
        .post('/api/admin/sync-toc')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);

      const counts = async () => {
        const [[a], [out], [oc]] = await Promise.all([
          ds.query<{ cnt: string }[]>(
            `SELECT COUNT(*) AS cnt FROM toc_aows WHERE program_id = ?`,
            [testProgramId],
          ),
          ds.query<{ cnt: string }[]>(
            `SELECT COUNT(*) AS cnt FROM toc_outputs WHERE program_id = ?`,
            [testProgramId],
          ),
          ds.query<{ cnt: string }[]>(
            `SELECT COUNT(*) AS cnt FROM toc_outcomes WHERE program_id = ?`,
            [testProgramId],
          ),
        ]);
        return {
          aows: Number(a.cnt),
          outputs: Number(out.cnt),
          outcomes: Number(oc.cnt),
        };
      };

      countsBefore = await counts();

      /* Second call — same stub, same fixture. */
      await request(app.getHttpServer())
        .post('/api/admin/sync-toc')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);

      countAfter = await counts();
    });

    it('toc_aows count is unchanged after second sync', () => {
      expect(countAfter.aows).toBe(countsBefore.aows);
    });

    it('toc_outputs count is unchanged after second sync', () => {
      expect(countAfter.outputs).toBe(countsBefore.outputs);
    });

    it('toc_outcomes count is unchanged after second sync', () => {
      expect(countAfter.outcomes).toBe(countsBefore.outcomes);
    });
  });

  /* ── 404 handling at HTTP layer ─────────────────────────── */

  describe('when all programs return 404', () => {
    it('returns 201 with synced=0 and all details having error=not_found', async () => {
      /* Stub returns null for every code (default mock value). */
      (tocService.fetchProgram as jest.Mock).mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .post('/api/admin/sync-toc')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(201);

      const body = res.body as {
        synced: number;
        failed: number;
        details: { error?: string }[];
      };
      expect(body.synced).toBe(0);
      expect(body.failed).toBeGreaterThan(0);
      body.details.forEach((d) => expect(d.error).toBe('not_found'));
    });
  });
});
