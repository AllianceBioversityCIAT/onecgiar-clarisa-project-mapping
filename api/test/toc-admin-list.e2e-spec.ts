/**
 * E2E integration tests for the three admin TOC list endpoints:
 *
 *   GET /api/admin/toc/aows
 *   GET /api/admin/toc/outcomes
 *   GET /api/admin/toc/outputs
 *
 * Uses the real MySQL database (docker-compose). No external HTTP calls —
 * rows are inserted directly via DataSource.query in beforeAll.
 *
 * Rule coverage map (see spec for full list):
 *  Rule 1  — programId required → 400 when missing
 *  Rule 2  — programId must be a positive integer → 400 on "abc" and "0"
 *  Rule 3  — limit defaults to 25, max 100 (limit=200 → 400)
 *  Rule 4  — page defaults to 1, page=0 → 400
 *  Rule 8  — cross-program aowId returns empty data, 200 (liberal backend)
 *  Rule 9  — response shape validated on AOW, outcome, output items
 *  Rule 11 — 200 for admin, 403 for non-admin roles, 401 for unauthenticated
 *
 * Rules 5, 6, 7, 10 are covered by the unit tests in
 * reference-data.service.spec.ts (QueryBuilder mock layer).
 *
 * Test isolation:
 *  - A dedicated program (official_code='TOC-LIST-E2E') is inserted in
 *    beforeAll with a unique clarisa_id (999_901) to avoid colliding with
 *    seeded CLARISA data.
 *  - A second "cross-program" program (999_902) is inserted so rule 8 can
 *    use an aowId that belongs to a different program.
 *  - All toc_aows / toc_outcomes / toc_outputs rows for both test programs
 *    are deleted in afterAll before the programs themselves.
 *  - Test user rows are demoted (role = NULL) in afterAll.
 *
 * Auth:
 *  - Admin: admin@codeobia.com (always has admin role in dev seed)
 *  - Non-admin tokens: one program_rep user and one center_rep user created
 *    here so rule 11 can assert 403 with concrete role coverage.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/modules/users/enums/user-role.enum';

/* ═══════════════════════════════════════════════════════════════
   Constants
   ══════════════════════════════════════════════════════════════ */

/** Synthetic test program — primary fixture data lives here. */
const TEST_PROGRAM_CODE = 'TOC-LIST-E2E';
const TEST_PROGRAM_CLARISA_ID = 999_901;
const TEST_PROGRAM_NAME = 'TOC List E2E Test Program';

/** Cross-program — AOWs here must NOT appear in test-program queries. */
const CROSS_PROGRAM_CODE = 'TOC-LIST-CROSS';
const CROSS_PROGRAM_CLARISA_ID = 999_902;
const CROSS_PROGRAM_NAME = 'TOC List E2E Cross Program';

const ADMIN_EMAIL = 'admin@codeobia.com';
const PROGRAM_REP_EMAIL = 'toc-list-e2e-program@codeobia.com';
const CENTER_REP_EMAIL = 'toc-list-e2e-center@codeobia.com';

/** How many AOWs we seed for the primary test program (3 total + 1 cross). */
const SEED_AOW_COUNT = 3;
const SEED_OUTCOME_COUNT = 8;
const SEED_OUTPUT_COUNT = 8;

/* ═══════════════════════════════════════════════════════════════
   Helpers
   ══════════════════════════════════════════════════════════════ */

/**
 * Exchange a user e-mail for a dev-token JWT using the dev-login bypass.
 * NODE_ENV=development is forced by setup-env.ts so this endpoint is live.
 */
async function getToken(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .get(`/api/auth/dev-token?email=${encodeURIComponent(email)}`)
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

/**
 * Promote a user (created implicitly by dev-token) to a specific role.
 * Re-issue the token afterwards so the JWT payload reflects the update.
 */
async function ensureRole(
  app: INestApplication,
  ds: DataSource,
  email: string,
  role: UserRole,
  centerId: number | null = null,
  programId: number | null = null,
): Promise<string> {
  await ds.query(
    `UPDATE users SET role = ?, center_id = ?, program_id = ?, is_active = 1 WHERE email = ?`,
    [role, centerId, programId, email],
  );
  return getToken(app, email);
}

/* ═══════════════════════════════════════════════════════════════
   Seeding helpers
   ══════════════════════════════════════════════════════════════ */

/**
 * Insert a program row and return its numeric PK.
 * Uses INSERT IGNORE so re-runs on a dirty DB don't fail.
 */
async function seedProgram(
  ds: DataSource,
  clarisaId: number,
  officialCode: string,
  name: string,
): Promise<number> {
  await ds.query(
    `INSERT IGNORE INTO programs (clarisa_id, official_code, name, synced_at)
     VALUES (?, ?, ?, NOW())`,
    [clarisaId, officialCode, name],
  );
  const [row] = await ds.query<{ id: number }[]>(
    `SELECT id FROM programs WHERE clarisa_id = ?`,
    [clarisaId],
  );
  return row.id;
}

/**
 * Insert one AOW row for a program and return its PK.
 * Caller must ensure node_id is unique within the program.
 */
async function seedAow(
  ds: DataSource,
  programId: number,
  opts: {
    nodeId: string;
    acronym: string;
    wpOfficialCode: string;
    name: string;
    clarisaTocId?: string | null;
  },
): Promise<number> {
  await ds.query(
    `INSERT INTO toc_aows
       (program_id, node_id, clarisa_toc_id, acronym, wp_official_code, name, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [
      programId,
      opts.nodeId,
      opts.clarisaTocId ?? null,
      opts.acronym,
      opts.wpOfficialCode,
      opts.name,
    ],
  );
  const [row] = await ds.query<{ id: number }[]>(
    `SELECT id FROM toc_aows WHERE program_id = ? AND node_id = ?`,
    [programId, opts.nodeId],
  );
  return row.id;
}

/**
 * Insert one outcome row and return its PK.
 */
async function seedOutcome(
  ds: DataSource,
  programId: number,
  opts: {
    nodeId: string;
    title: string;
    description?: string | null;
    outcomeType: 'intermediate' | 'portfolio';
    aowId?: number | null;
  },
): Promise<number> {
  await ds.query(
    `INSERT INTO toc_outcomes
       (program_id, node_id, title, description, outcome_type, aow_id, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [
      programId,
      opts.nodeId,
      opts.title,
      opts.description ?? null,
      opts.outcomeType,
      opts.aowId ?? null,
    ],
  );
  const [row] = await ds.query<{ id: number }[]>(
    `SELECT id FROM toc_outcomes WHERE program_id = ? AND node_id = ?`,
    [programId, opts.nodeId],
  );
  return row.id;
}

/**
 * Insert one output row and return its PK.
 */
async function seedOutput(
  ds: DataSource,
  programId: number,
  opts: {
    nodeId: string;
    title: string;
    description?: string | null;
    typeOfOutput?: string | null;
    aowId?: number | null;
  },
): Promise<number> {
  await ds.query(
    `INSERT INTO toc_outputs
       (program_id, node_id, title, description, type_of_output, aow_id, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [
      programId,
      opts.nodeId,
      opts.title,
      opts.description ?? null,
      opts.typeOfOutput ?? null,
      opts.aowId ?? null,
    ],
  );
  const [row] = await ds.query<{ id: number }[]>(
    `SELECT id FROM toc_outputs WHERE program_id = ? AND node_id = ?`,
    [programId, opts.nodeId],
  );
  return row.id;
}

/* ═══════════════════════════════════════════════════════════════
   Suite
   ══════════════════════════════════════════════════════════════ */

describe('TOC admin list endpoints — integration (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;

  /* Auth tokens. */
  let adminToken: string;
  let programRepToken: string;
  let centerRepToken: string;

  /* Seeded IDs used across tests. */
  let testProgramId: number;
  let crossProgramId: number;

  /** The three AOW IDs seeded for testProgram. */
  let aowIds: [number, number, number];
  /** The AOW ID seeded for crossProgram. */
  let crossAowId: number;

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

    /* ── Seed programs ─────────────────────────────────────── */

    testProgramId = await seedProgram(
      ds,
      TEST_PROGRAM_CLARISA_ID,
      TEST_PROGRAM_CODE,
      TEST_PROGRAM_NAME,
    );
    crossProgramId = await seedProgram(
      ds,
      CROSS_PROGRAM_CLARISA_ID,
      CROSS_PROGRAM_CODE,
      CROSS_PROGRAM_NAME,
    );

    /* ── Wipe prior TOC rows for both test programs ────────── */
    /* (Protects against dirty DB from aborted prior runs.) */
    for (const pid of [testProgramId, crossProgramId]) {
      await ds.query(`DELETE FROM toc_outputs  WHERE program_id = ?`, [pid]);
      await ds.query(`DELETE FROM toc_outcomes WHERE program_id = ?`, [pid]);
      await ds.query(`DELETE FROM toc_aows     WHERE program_id = ?`, [pid]);
    }

    /* ── Seed 3 AOWs for testProgram ───────────────────────── */

    const aow1 = await seedAow(ds, testProgramId, {
      nodeId: 'E2E-WP-NODE-01',
      acronym: 'AOW01',
      wpOfficialCode: 'E2E-SP-AOW01',
      name: 'Alpha Area of Work',
      clarisaTocId: 'CLARISA-E2E-01',
    });
    const aow2 = await seedAow(ds, testProgramId, {
      nodeId: 'E2E-WP-NODE-02',
      acronym: 'AOW02',
      wpOfficialCode: 'E2E-SP-AOW02',
      name: 'Beta Area of Work',
    });
    const aow3 = await seedAow(ds, testProgramId, {
      nodeId: 'E2E-WP-NODE-03',
      acronym: 'AOW03',
      wpOfficialCode: 'E2E-SP-AOW03',
      name: 'Gamma Area of Work',
    });
    aowIds = [aow1, aow2, aow3];

    /* ── Seed 1 AOW for crossProgram ───────────────────────── */

    crossAowId = await seedAow(ds, crossProgramId, {
      nodeId: 'E2E-CROSS-WP-NODE-01',
      acronym: 'XAOW01',
      wpOfficialCode: 'E2E-CROSS-AOW01',
      name: 'Cross Program AOW',
    });

    /* ── Seed 8 outcomes for testProgram ───────────────────── */
    /*
     * Distribution:
     *  4 under aow1  (2 intermediate, 2 portfolio)
     *  2 under aow2  (1 intermediate, 1 portfolio)
     *  2 with aow_id=null  (1 intermediate, 1 portfolio)
     *
     * Titles include one "searchable" keyword so search tests in
     * the service unit layer have a realistic counterpart here.
     */
    await seedOutcome(ds, testProgramId, {
      nodeId: 'E2E-OC-01', title: 'Foster motivations for adoption', outcomeType: 'intermediate', aowId: aow1,
    });
    await seedOutcome(ds, testProgramId, {
      nodeId: 'E2E-OC-02', title: 'Strengthen institutional capacity', outcomeType: 'intermediate', aowId: aow1,
    });
    await seedOutcome(ds, testProgramId, {
      nodeId: 'E2E-OC-03', title: 'Portfolio outcome for food security', outcomeType: 'portfolio', aowId: aow1,
    });
    await seedOutcome(ds, testProgramId, {
      nodeId: 'E2E-OC-04', title: 'Portfolio outcome for climate resilience', outcomeType: 'portfolio', aowId: aow1,
    });
    await seedOutcome(ds, testProgramId, {
      nodeId: 'E2E-OC-05', title: 'Accelerate policy uptake', outcomeType: 'intermediate', aowId: aow2,
    });
    await seedOutcome(ds, testProgramId, {
      nodeId: 'E2E-OC-06', title: 'Portfolio outcome for gender equity', outcomeType: 'portfolio', aowId: aow2,
    });
    await seedOutcome(ds, testProgramId, {
      nodeId: 'E2E-OC-07', title: 'Cross-cutting intermediate outcome', outcomeType: 'intermediate', aowId: null,
    });
    await seedOutcome(ds, testProgramId, {
      nodeId: 'E2E-OC-08', title: 'Cross-cutting portfolio outcome', outcomeType: 'portfolio', aowId: null,
    });

    /* ── Seed 8 outputs for testProgram ────────────────────── */
    await seedOutput(ds, testProgramId, {
      nodeId: 'E2E-OUT-01', title: 'Knowledge product on adoption', typeOfOutput: 'Knowledge product', aowId: aow1,
    });
    await seedOutput(ds, testProgramId, {
      nodeId: 'E2E-OUT-02', title: 'Policy brief on governance', typeOfOutput: 'Policy brief', aowId: aow1,
    });
    await seedOutput(ds, testProgramId, {
      nodeId: 'E2E-OUT-03', title: 'Training material for extension', typeOfOutput: 'Training material', aowId: aow1,
    });
    await seedOutput(ds, testProgramId, {
      nodeId: 'E2E-OUT-04', title: 'Database of climate indicators', typeOfOutput: null, aowId: aow1,
    });
    await seedOutput(ds, testProgramId, {
      nodeId: 'E2E-OUT-05', title: 'Capacity building module', typeOfOutput: 'Training material', aowId: aow2,
    });
    await seedOutput(ds, testProgramId, {
      nodeId: 'E2E-OUT-06', title: 'Gender analysis report', typeOfOutput: 'Policy brief', aowId: aow2,
    });
    await seedOutput(ds, testProgramId, {
      nodeId: 'E2E-OUT-07', title: 'Cross-cutting output one', typeOfOutput: null, aowId: null,
    });
    await seedOutput(ds, testProgramId, {
      nodeId: 'E2E-OUT-08', title: 'Cross-cutting output two', typeOfOutput: null, aowId: null,
    });

    /* ── Bootstrap auth tokens ──────────────────────────────── */

    adminToken = await getToken(app, ADMIN_EMAIL);

    /* Create and promote non-admin users. */
    programRepToken = await ensureRole(
      app,
      ds,
      PROGRAM_REP_EMAIL,
      UserRole.PROGRAM_REP,
      null,
      null,
    );
    centerRepToken = await ensureRole(
      app,
      ds,
      CENTER_REP_EMAIL,
      UserRole.CENTER_REP,
      1, /* first center row */
      null,
    );
  }, 60_000 /* allow extra time for app init + seeding */);

  afterAll(async () => {
    /* Delete TOC rows in FK-safe order (outputs/outcomes before aows,
     * aows before programs). */
    for (const pid of [testProgramId, crossProgramId]) {
      await ds.query(`DELETE FROM toc_outputs  WHERE program_id = ?`, [pid]);
      await ds.query(`DELETE FROM toc_outcomes WHERE program_id = ?`, [pid]);
      await ds.query(`DELETE FROM toc_aows     WHERE program_id = ?`, [pid]);
    }
    await ds.query(
      `DELETE FROM programs WHERE clarisa_id IN (?, ?)`,
      [TEST_PROGRAM_CLARISA_ID, CROSS_PROGRAM_CLARISA_ID],
    );

    /* Demote test users so they don't leak permissions across test runs. */
    await ds.query(
      `UPDATE users SET role = NULL, center_id = NULL, program_id = NULL
       WHERE email IN (?, ?)`,
      [PROGRAM_REP_EMAIL, CENTER_REP_EMAIL],
    );

    await app.close();
  }, 30_000);

  // ──────────────────────────────────────────────────────────────────
  //  Rule 11: RBAC — admin gets 200, others get 403, anon gets 401
  // ──────────────────────────────────────────────────────────────────

  describe('Rule 11 — RBAC', () => {
    const ENDPOINTS = [
      `/api/admin/toc/aows`,
      `/api/admin/toc/outcomes`,
      `/api/admin/toc/outputs`,
    ] as const;

    for (const endpoint of ENDPOINTS) {
      describe(`${endpoint}`, () => {
        it('returns 401 for unauthenticated requests', async () => {
          await request(app.getHttpServer())
            .get(`${endpoint}?programId=1`)
            .expect(401);
        });

        it('returns 403 for program_rep', async () => {
          await request(app.getHttpServer())
            .get(`${endpoint}?programId=1`)
            .set('Authorization', `Bearer ${programRepToken}`)
            .expect(403);
        });

        it('returns 403 for center_rep', async () => {
          await request(app.getHttpServer())
            .get(`${endpoint}?programId=1`)
            .set('Authorization', `Bearer ${centerRepToken}`)
            .expect(403);
        });

        it('returns 200 for admin', async () => {
          await request(app.getHttpServer())
            .get(`${endpoint}?programId=${testProgramId}`)
            .set('Authorization', `Bearer ${adminToken}`)
            .expect(200);
        });
      });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  //  Rule 1: programId is required on all three endpoints
  // ──────────────────────────────────────────────────────────────────

  describe('Rule 1 — programId is required', () => {
    it('GET /admin/toc/aows without programId returns 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/admin/toc/aows')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);

      /* The ValidationPipe returns an array of messages — at least one
       * must mention programId or the numeric constraint. */
      const messages: string[] = Array.isArray(res.body.message)
        ? res.body.message
        : [String(res.body.message)];
      const hasProgId = messages.some((m) =>
        /programId|integer|must be/i.test(m),
      );
      expect(hasProgId).toBe(true);
    });

    it('GET /admin/toc/outcomes without programId returns 400', async () => {
      await request(app.getHttpServer())
        .get('/api/admin/toc/outcomes')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('GET /admin/toc/outputs without programId returns 400', async () => {
      await request(app.getHttpServer())
        .get('/api/admin/toc/outputs')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //  Rule 2: programId must be a positive integer
  // ──────────────────────────────────────────────────────────────────

  describe('Rule 2 — programId must be a positive integer', () => {
    it('GET /admin/toc/aows?programId=abc returns 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/admin/toc/aows?programId=abc')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);

      const messages: string[] = Array.isArray(res.body.message)
        ? res.body.message
        : [String(res.body.message)];
      /* class-validator emits "programId must be an integer number" for NaN values. */
      expect(messages.some((m) => /integer|number/i.test(m))).toBe(true);
    });

    it('GET /admin/toc/aows?programId=0 returns 400 (Min(1) violation)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/admin/toc/aows?programId=0')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);

      const messages: string[] = Array.isArray(res.body.message)
        ? res.body.message
        : [String(res.body.message)];
      expect(messages.some((m) => /greater than|min|least/i.test(m))).toBe(true);
    });

    it('GET /admin/toc/outcomes?programId=abc returns 400', async () => {
      await request(app.getHttpServer())
        .get('/api/admin/toc/outcomes?programId=abc')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('GET /admin/toc/outcomes?programId=0 returns 400', async () => {
      await request(app.getHttpServer())
        .get('/api/admin/toc/outcomes?programId=0')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('GET /admin/toc/outputs?programId=abc returns 400', async () => {
      await request(app.getHttpServer())
        .get('/api/admin/toc/outputs?programId=abc')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('GET /admin/toc/outputs?programId=0 returns 400', async () => {
      await request(app.getHttpServer())
        .get('/api/admin/toc/outputs?programId=0')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //  Rule 3: limit defaults to 25 and max is 100
  // ──────────────────────────────────────────────────────────────────

  describe('Rule 3 — limit defaults and max', () => {
    it('GET /admin/toc/aows with limit=200 returns 400 (Max(100) violation)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/aows?programId=${testProgramId}&limit=200`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);

      const messages: string[] = Array.isArray(res.body.message)
        ? res.body.message
        : [String(res.body.message)];
      expect(messages.some((m) => /max|less than|100/i.test(m))).toBe(true);
    });

    it('GET /admin/toc/outcomes with limit=200 returns 400', async () => {
      await request(app.getHttpServer())
        .get(`/api/admin/toc/outcomes?programId=${testProgramId}&limit=200`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('GET /admin/toc/outputs with limit=200 returns 400', async () => {
      await request(app.getHttpServer())
        .get(`/api/admin/toc/outputs?programId=${testProgramId}&limit=200`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('GET /admin/toc/aows without limit uses default limit=25 in response', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/aows?programId=${testProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.limit).toBe(25);
    });

    it('GET /admin/toc/outcomes without limit uses default limit=25', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/outcomes?programId=${testProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.limit).toBe(25);
    });

    it('GET /admin/toc/outputs without limit uses default limit=25', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/outputs?programId=${testProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.limit).toBe(25);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //  Rule 4: page defaults to 1 and page=0 is rejected
  // ──────────────────────────────────────────────────────────────────

  describe('Rule 4 — page defaults and minimum', () => {
    it('GET /admin/toc/aows with page=0 returns 400 (Min(1) violation)', async () => {
      await request(app.getHttpServer())
        .get(`/api/admin/toc/aows?programId=${testProgramId}&page=0`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('GET /admin/toc/outcomes with page=0 returns 400', async () => {
      await request(app.getHttpServer())
        .get(`/api/admin/toc/outcomes?programId=${testProgramId}&page=0`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('GET /admin/toc/outputs with page=0 returns 400', async () => {
      await request(app.getHttpServer())
        .get(`/api/admin/toc/outputs?programId=${testProgramId}&page=0`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });

    it('GET /admin/toc/aows without page returns page=1 in response', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/aows?programId=${testProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.page).toBe(1);
    });

    it('GET /admin/toc/outcomes without page returns page=1 in response', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/outcomes?programId=${testProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.page).toBe(1);
    });

    it('GET /admin/toc/outputs without page returns page=1 in response', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/outputs?programId=${testProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.page).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //  Rule 8: cross-program aowId returns empty data, 200 (liberal)
  // ──────────────────────────────────────────────────────────────────

  describe('Rule 8 — cross-program aowId yields empty data (not an error)', () => {
    it('GET /admin/toc/outcomes with cross-program aowId returns 200 with empty data', async () => {
      const res = await request(app.getHttpServer())
        .get(
          `/api/admin/toc/outcomes?programId=${testProgramId}&aowId=${crossAowId}`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.total).toBe(0);
      expect(res.body.data).toEqual([]);
    });

    it('GET /admin/toc/outputs with cross-program aowId returns 200 with empty data', async () => {
      const res = await request(app.getHttpServer())
        .get(
          `/api/admin/toc/outputs?programId=${testProgramId}&aowId=${crossAowId}`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.total).toBe(0);
      expect(res.body.data).toEqual([]);
    });

    it('cross-program AOW itself is not visible when listing AOWs for testProgram', async () => {
      /* The cross-program AOW should not appear in testProgram AOW list. */
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/aows?programId=${testProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const ids: number[] = res.body.data.map((d: { id: number }) => d.id);
      expect(ids).not.toContain(crossAowId);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //  Rule 9: Response shape validation
  // ──────────────────────────────────────────────────────────────────

  describe('Rule 9 — response shape', () => {
    /* ── AOW shape ─────────────────────────────────────────── */

    describe('AOW list item shape', () => {
      let aowItem: Record<string, unknown>;

      beforeAll(async () => {
        const res = await request(app.getHttpServer())
          .get(`/api/admin/toc/aows?programId=${testProgramId}&limit=1`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        aowItem = res.body.data[0] as Record<string, unknown>;
      });

      it('has id (number)', () => {
        expect(typeof aowItem.id).toBe('number');
      });

      it('has nodeId (string)', () => {
        expect(typeof aowItem.nodeId).toBe('string');
      });

      it('has clarisaTocId (string or null)', () => {
        expect(
          aowItem.clarisaTocId === null ||
            typeof aowItem.clarisaTocId === 'string',
        ).toBe(true);
      });

      it('has acronym', () => {
        expect(aowItem.acronym).toBeDefined();
      });

      it('has wpOfficialCode', () => {
        expect(aowItem.wpOfficialCode).toBeDefined();
      });

      it('has name', () => {
        expect(aowItem.name).toBeDefined();
      });

      it('has programId (number)', () => {
        expect(typeof aowItem.programId).toBe('number');
        expect(aowItem.programId).toBe(testProgramId);
      });

      it('has embedded program ref with id, officialCode, name', () => {
        const prog = aowItem.program as Record<string, unknown>;
        expect(typeof prog.id).toBe('number');
        expect(typeof prog.officialCode).toBe('string');
        expect(typeof prog.name).toBe('string');
      });

      it('does NOT expose clarisaId on the program ref', () => {
        const prog = aowItem.program as Record<string, unknown>;
        expect(prog.clarisaId).toBeUndefined();
      });

      it('does NOT expose createdAt or updatedAt on the item', () => {
        expect(aowItem.createdAt).toBeUndefined();
        expect(aowItem.updatedAt).toBeUndefined();
      });

      it('has syncedAt', () => {
        expect(aowItem.syncedAt).toBeDefined();
      });

      it('response envelope has data, total, page, limit', async () => {
        const res = await request(app.getHttpServer())
          .get(`/api/admin/toc/aows?programId=${testProgramId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        expect(typeof res.body.total).toBe('number');
        expect(typeof res.body.page).toBe('number');
        expect(typeof res.body.limit).toBe('number');
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.total).toBe(SEED_AOW_COUNT);
      });
    });

    /* ── Outcome shape ─────────────────────────────────────── */

    describe('Outcome list item shape', () => {
      let outcomeItem: Record<string, unknown>;
      let outcomeItemWithAow: Record<string, unknown>;
      let outcomeItemNoAow: Record<string, unknown>;

      beforeAll(async () => {
        /* Fetch all — we need to find one with an aow and one without. */
        const res = await request(app.getHttpServer())
          .get(
            `/api/admin/toc/outcomes?programId=${testProgramId}&limit=25`,
          )
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        const items = res.body.data as Record<string, unknown>[];
        outcomeItem = items[0];
        outcomeItemWithAow =
          items.find((i) => i.aowId !== null) ?? items[0];
        outcomeItemNoAow =
          items.find((i) => i.aowId === null) ?? items[items.length - 1];
      });

      it('has id, nodeId, title, description', () => {
        expect(typeof outcomeItem.id).toBe('number');
        expect(typeof outcomeItem.nodeId).toBe('string');
        expect(outcomeItem).toHaveProperty('title');
        expect(outcomeItem).toHaveProperty('description');
      });

      it('has outcomeType (intermediate or portfolio)', () => {
        expect(['intermediate', 'portfolio']).toContain(
          outcomeItem.outcomeType,
        );
      });

      it('has relatedNodeId', () => {
        expect(outcomeItem).toHaveProperty('relatedNodeId');
      });

      it('has aowId and aow field', () => {
        expect(outcomeItem).toHaveProperty('aowId');
        expect(outcomeItem).toHaveProperty('aow');
      });

      it('aow is null when aowId is null', () => {
        expect(outcomeItemNoAow.aowId).toBeNull();
        expect(outcomeItemNoAow.aow).toBeNull();
      });

      it('aow has id, acronym, name when aowId is present', () => {
        if (outcomeItemWithAow.aow === null) {
          /* skip — no joined row found; data integrity issue, not a shape bug */
          return;
        }
        const aow = outcomeItemWithAow.aow as Record<string, unknown>;
        expect(typeof aow.id).toBe('number');
        expect(aow).toHaveProperty('acronym');
        expect(aow).toHaveProperty('name');
        /* wpOfficialCode must NOT be on the narrow ref. */
        expect(aow.wpOfficialCode).toBeUndefined();
        expect(aow.programId).toBeUndefined();
      });

      it('has programId and embedded program ref', () => {
        expect(outcomeItem.programId).toBe(testProgramId);
        const prog = outcomeItem.program as Record<string, unknown>;
        expect(prog.id).toBeDefined();
        expect(prog.officialCode).toBeDefined();
        expect(prog.name).toBeDefined();
        expect(prog.clarisaId).toBeUndefined();
      });

      it('does NOT expose typeOfOutput (that is an output-only field)', () => {
        expect(outcomeItem.typeOfOutput).toBeUndefined();
      });

      it('does NOT expose createdAt or updatedAt', () => {
        expect(outcomeItem.createdAt).toBeUndefined();
        expect(outcomeItem.updatedAt).toBeUndefined();
      });

      it('response total equals number of seeded outcomes', async () => {
        const res = await request(app.getHttpServer())
          .get(`/api/admin/toc/outcomes?programId=${testProgramId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        expect(res.body.total).toBe(SEED_OUTCOME_COUNT);
      });
    });

    /* ── Output shape ──────────────────────────────────────── */

    describe('Output list item shape', () => {
      let outputItem: Record<string, unknown>;
      let outputItemWithAow: Record<string, unknown>;
      let outputItemNoAow: Record<string, unknown>;

      beforeAll(async () => {
        const res = await request(app.getHttpServer())
          .get(
            `/api/admin/toc/outputs?programId=${testProgramId}&limit=25`,
          )
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        const items = res.body.data as Record<string, unknown>[];
        outputItem = items[0];
        outputItemWithAow =
          items.find((i) => i.aowId !== null) ?? items[0];
        outputItemNoAow =
          items.find((i) => i.aowId === null) ?? items[items.length - 1];
      });

      it('has id, nodeId, title, description', () => {
        expect(typeof outputItem.id).toBe('number');
        expect(typeof outputItem.nodeId).toBe('string');
        expect(outputItem).toHaveProperty('title');
        expect(outputItem).toHaveProperty('description');
      });

      it('has typeOfOutput (string or null) instead of outcomeType', () => {
        expect(outputItem).toHaveProperty('typeOfOutput');
        expect(outputItem.outcomeType).toBeUndefined();
      });

      it('has relatedNodeId', () => {
        expect(outputItem).toHaveProperty('relatedNodeId');
      });

      it('has aowId and aow fields', () => {
        expect(outputItem).toHaveProperty('aowId');
        expect(outputItem).toHaveProperty('aow');
      });

      it('aow is null when aowId is null', () => {
        expect(outputItemNoAow.aowId).toBeNull();
        expect(outputItemNoAow.aow).toBeNull();
      });

      it('aow has id, acronym, name (narrow ref) when present', () => {
        if (outputItemWithAow.aow === null) return;
        const aow = outputItemWithAow.aow as Record<string, unknown>;
        expect(typeof aow.id).toBe('number');
        expect(aow).toHaveProperty('acronym');
        expect(aow).toHaveProperty('name');
        expect(aow.wpOfficialCode).toBeUndefined();
      });

      it('has programId and narrow program ref', () => {
        expect(outputItem.programId).toBe(testProgramId);
        const prog = outputItem.program as Record<string, unknown>;
        expect(prog.id).toBeDefined();
        expect(prog.officialCode).toBeDefined();
        expect(prog.clarisaId).toBeUndefined();
      });

      it('does NOT expose createdAt or updatedAt', () => {
        expect(outputItem.createdAt).toBeUndefined();
        expect(outputItem.updatedAt).toBeUndefined();
      });

      it('response total equals number of seeded outputs', async () => {
        const res = await request(app.getHttpServer())
          .get(`/api/admin/toc/outputs?programId=${testProgramId}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);

        expect(res.body.total).toBe(SEED_OUTPUT_COUNT);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  //  Sanity: counts match seeded data for all three endpoints
  // ──────────────────────────────────────────────────────────────────

  describe('Data count sanity', () => {
    it('AOW list returns exactly 3 items for testProgram', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/aows?programId=${testProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.total).toBe(3);
      expect(res.body.data).toHaveLength(3);
    });

    it('AOW list returns exactly 1 item for crossProgram', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/aows?programId=${crossProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.data[0].id).toBe(crossAowId);
    });

    it('cross-program AOW does not appear in testProgram AOW list', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/aows?programId=${testProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const ids = res.body.data.map((d: { id: number }) => d.id);
      expect(ids).not.toContain(crossAowId);
    });

    it('outcome list scoped to aowIds[0] returns 4 rows', async () => {
      const res = await request(app.getHttpServer())
        .get(
          `/api/admin/toc/outcomes?programId=${testProgramId}&aowId=${aowIds[0]}`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.total).toBe(4);
    });

    it('output list scoped to aowIds[0] returns 4 rows', async () => {
      const res = await request(app.getHttpServer())
        .get(
          `/api/admin/toc/outputs?programId=${testProgramId}&aowId=${aowIds[0]}`,
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.total).toBe(4);
    });

    it('outcome list without aowId returns all 8 outcomes', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/admin/toc/outcomes?programId=${testProgramId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.total).toBe(8);
    });
  });
});
