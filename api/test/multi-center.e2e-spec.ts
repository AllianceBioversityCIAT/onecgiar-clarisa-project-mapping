/**
 * E2E integration tests for the multi-center center_rep feature (Wave C-3).
 *
 * Covers:
 *  - ActiveCenterInterceptor header validation over real HTTP
 *  - X-Active-Center scope switching (projects filtered by active center)
 *  - POST /users + PATCH /users/:id with centerIds via admin API
 *  - GET /auth/me response includes centerIds
 *  - Downstream scoping: exclusion cross-center block, mapping create/lock
 *  - Stale-JWT scenario: revoke center then fresh token with old header → 403 (C3-12)
 *
 * Database pre-condition: the `user_centers` table from migration
 * `1779000000000-AddUserCentersTable` must exist. This spec creates it
 * inline in `beforeAll` when missing (idempotent check via
 * `information_schema.TABLES`), and leaves it in place after the run so
 * subsequent re-runs are safe.
 *
 * Isolation strategy:
 *  - All test rows use the prefix `MC-E2E-` on project codes and the
 *    email `mc-e2e-center@codeobia.com` so teardown is deterministic.
 *  - `beforeAll` starts with a pre-clean of any leftover rows from a
 *    previous failed run, ensuring idempotency.
 *  - Teardown deletes in FK-safe order: mapping negotiations → mappings
 *    → project messages → project exclusions → projects → users.
 *
 * Centers used:
 *  C1 = id 1 (AfricaRice)   — always seeded from CLARISA
 *  C2 = id 2 (BIOVERSITY)   — always seeded from CLARISA
 *  C3_UNKNOWN = id 3 (CIAT) — a real center the test user is NOT a member of
 *  PROG_ID = id 1 (SP01)    — always seeded from CLARISA
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/modules/users/enums/user-role.enum';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const CODE_PREFIX = 'MC-E2E-';
const ADMIN_EMAIL = 'admin@codeobia.com';
const CENTER_REP_EMAIL = 'mc-e2e-center@codeobia.com';

const C1 = 1; // AfricaRice
const C2 = 2; // BIOVERSITY
const C3_UNKNOWN = 3; // CIAT — not in the rep's center list
const PROG_ID = 1; // SP01 "Breeding for Tomorrow"

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Issue a dev-token JWT for the given email. NODE_ENV must be
 * 'development' (enforced by test/setup-env.ts).
 */
async function getToken(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .get(`/api/auth/dev-token?email=${encodeURIComponent(email)}`)
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

/**
 * Delete all rows seeded by this suite in FK-safe order. Called both at
 * the top of `beforeAll` (pre-clean) and in `afterAll` (teardown).
 */
async function cleanupTestRows(ds: DataSource): Promise<void> {
  await ds.query(
    `DELETE n FROM mapping_negotiations n
       INNER JOIN project_mappings m ON m.id = n.mapping_id
       INNER JOIN projects p ON p.id = m.project_id
       WHERE p.code LIKE '${CODE_PREFIX}%'`,
  );
  await ds.query(
    `DELETE pm FROM project_mappings pm
       INNER JOIN projects p ON p.id = pm.project_id
       WHERE p.code LIKE '${CODE_PREFIX}%'`,
  );
  await ds.query(
    `DELETE FROM project_negotiation_messages WHERE project_id IN
       (SELECT id FROM projects WHERE code LIKE '${CODE_PREFIX}%')`,
  );
  await ds.query(
    `DELETE FROM project_exclusions WHERE project_id IN
       (SELECT id FROM projects WHERE code LIKE '${CODE_PREFIX}%')`,
  );
  await ds.query(`DELETE FROM projects WHERE code LIKE '${CODE_PREFIX}%'`);
  /* Deleting the user cascades user_centers rows via FK_user_centers_user. */
  await ds.query(`DELETE FROM users WHERE email = ?`, [CENTER_REP_EMAIL]);
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

describe('Multi-center center_rep — integration (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;

  let adminToken: string;
  /** Token issued immediately after user creation (centerIds=[C1,C2]). */
  let centerRepToken: string;

  let centerRepUserId: number;
  let projectC1Id: number;
  let projectC2Id: number;

  /**
   * Snapshot of junction rows captured right after user creation (C3-9).
   * This is read-only and unaffected by the C3-10 PATCH that changes
   * membership later in the suite.
   */
  let initialJunctionRows: Array<{
    center_id: number;
    sort_order: number;
  }>;

  /* ---------------------------------------------------------------- */
  /* beforeAll — boot app, ensure table, pre-clean, seed              */
  /* ---------------------------------------------------------------- */
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

    /* ---- 1. Ensure user_centers table exists --------------------- */
    const tableCheck = await ds.query<{ TABLE_NAME: string }[]>(
      `SELECT TABLE_NAME
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'user_centers'`,
    );
    if (tableCheck.length === 0) {
      /* Run migration DDL inline (same SQL as AddUserCentersTable1779000000000). */
      await ds.query(`
        CREATE TABLE \`user_centers\` (
          \`user_id\`     INT         NOT NULL,
          \`center_id\`   INT         NOT NULL,
          \`sort_order\`  INT         NOT NULL DEFAULT 0,
          \`created_at\`  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          PRIMARY KEY (\`user_id\`, \`center_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
      `);
      await ds.query(
        `CREATE INDEX \`idx_user_centers_center_id\` ON \`user_centers\` (\`center_id\`)`,
      );
      await ds.query(
        `CREATE INDEX \`idx_user_centers_user_sort\` ON \`user_centers\` (\`user_id\`, \`sort_order\`)`,
      );
      await ds.query(`
        ALTER TABLE \`user_centers\`
          ADD CONSTRAINT \`FK_user_centers_user\`
          FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`)
          ON DELETE CASCADE ON UPDATE CASCADE
      `);
      await ds.query(`
        ALTER TABLE \`user_centers\`
          ADD CONSTRAINT \`FK_user_centers_center\`
          FOREIGN KEY (\`center_id\`) REFERENCES \`centers\`(\`id\`)
          ON DELETE CASCADE ON UPDATE CASCADE
      `);
      /* Backfill existing single-center users. */
      await ds.query(`
        INSERT INTO \`user_centers\` (\`user_id\`, \`center_id\`, \`sort_order\`)
        SELECT \`id\`, \`center_id\`, 0
        FROM \`users\`
        WHERE \`center_id\` IS NOT NULL
      `);
      /* Record in migrations table so TypeORM CLI stays in sync. */
      await ds.query(
        `INSERT IGNORE INTO \`migrations\` (\`timestamp\`, \`name\`)
           VALUES (1779000000000, 'AddUserCentersTable1779000000000')`,
      );
    }

    /* ---- 2. Pre-clean: remove any leftovers from a prior failed run */
    await cleanupTestRows(ds);

    /* ---- 3. Obtain admin token ----------------------------------- */
    adminToken = await getToken(app, ADMIN_EMAIL);

    /* ---- 4. Create the center_rep user via admin API (covers C3-9) */
    const createRes = await request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: CENTER_REP_EMAIL,
        firstName: 'MultiCenter',
        lastName: 'E2E',
        role: UserRole.CENTER_REP,
        centerIds: [C1, C2],
      })
      .expect(201);

    centerRepUserId = (createRes.body as { id: number }).id;

    /* ---- 5. Snapshot junction rows immediately (before any PATCH) - */
    initialJunctionRows = await ds.query<
      { center_id: number; sort_order: number }[]
    >(
      `SELECT center_id, sort_order
         FROM user_centers
         WHERE user_id = ?
         ORDER BY sort_order ASC`,
      [centerRepUserId],
    );

    /* ---- 6. Issue fresh token for the center_rep --------------- */
    centerRepToken = await getToken(app, CENTER_REP_EMAIL);

    /* ---- 7. Seed one project per center via admin --------------- */
    const codeC1 = `${CODE_PREFIX}C1-${Date.now()}`;
    const c1Res = await request(app.getHttpServer())
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: codeC1,
        name: 'Multi-Center E2E Project C1',
        totalBudget: 50000,
        centerId: C1,
      })
      .expect(201);
    projectC1Id = (c1Res.body as { id: number }).id;

    const codeC2 = `${CODE_PREFIX}C2-${Date.now() + 1}`;
    const c2Res = await request(app.getHttpServer())
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: codeC2,
        name: 'Multi-Center E2E Project C2',
        totalBudget: 60000,
        centerId: C2,
      })
      .expect(201);
    projectC2Id = (c2Res.body as { id: number }).id;
  }, 60_000);

  /* ---------------------------------------------------------------- */
  /* afterAll — clean up in FK-safe order                             */
  /* ---------------------------------------------------------------- */
  afterAll(async () => {
    await cleanupTestRows(ds);
    await app.close();
  }, 30_000);

  /* ================================================================ */
  /* C3-8: GET /auth/me — centerIds present and ordered               */
  /* ================================================================ */
  it('C3-8: GET /auth/me includes centerIds: [C1, C2] and centerId: C1', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${centerRepToken}`)
      .expect(200);

    const body = res.body as { centerIds: number[]; centerId: number };
    expect(body.centerIds).toEqual([C1, C2]);
    expect(body.centerId).toBe(C1);
  });

  /* ================================================================ */
  /* C3-9: POST /users with centerIds creates two user_centers rows   */
  /* ================================================================ */
  /* `replaceUserCenters()` now uses a raw parameterised INSERT with an
   * explicit column list (`user_id, center_id, sort_order`) via
   * `manager.query()`. This sidesteps the TypeORM QueryBuilder bug
   * (multi-row VALUES against a non-entity table mis-cloned row[0]'s
   * `sort_order` for every subsequent row), and the primary-center
   * ordering contract — first element in `centerIds` is the primary —
   * is preserved. The two rows below should have distinct sort_order
   * values (0 for C1, 1 for C2), confirmed by a direct SELECT against
   * the live MySQL junction. */
  it('C3-9: POST /users with centerIds=[C1,C2] creates exactly two user_centers rows in sort order', () => {
    /* Uses the `initialJunctionRows` snapshot captured right after
     * user creation in beforeAll — unaffected by the C3-10 PATCH. */
    expect(initialJunctionRows).toHaveLength(2);
    expect(initialJunctionRows[0]).toMatchObject({
      center_id: C1,
      sort_order: 0,
    });
    expect(initialJunctionRows[1]).toMatchObject({
      center_id: C2,
      sort_order: 1,
    });
  });

  /* ================================================================ */
  /* C3-1: X-Active-Center: C1 → GET /projects returns C1 projects   */
  /* ================================================================ */
  it('C3-1: X-Active-Center: C1 — GET /projects returns only C1 projects', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/projects')
      .set('Authorization', `Bearer ${centerRepToken}`)
      .set('X-Active-Center', String(C1))
      .expect(200);

    const body = res.body as { data: { id: number; centerId: number }[] };
    const nonC1 = body.data.filter((p) => p.centerId !== C1);
    expect(nonC1).toHaveLength(0);
    const ids = body.data.map((p) => p.id);
    expect(ids).toContain(projectC1Id);
    expect(ids).not.toContain(projectC2Id);
  });

  /* ================================================================ */
  /* C3-2: X-Active-Center: C2 → GET /projects returns C2 projects   */
  /* ================================================================ */
  it('C3-2: X-Active-Center: C2 — GET /projects returns only C2 projects', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/projects')
      .set('Authorization', `Bearer ${centerRepToken}`)
      .set('X-Active-Center', String(C2))
      .expect(200);

    const body = res.body as { data: { id: number; centerId: number }[] };
    const nonC2 = body.data.filter((p) => p.centerId !== C2);
    expect(nonC2).toHaveLength(0);
    const ids = body.data.map((p) => p.id);
    expect(ids).toContain(projectC2Id);
    expect(ids).not.toContain(projectC1Id);
  });

  /* ================================================================ */
  /* C3-5: X-Active-Center not in centerIds → 403                    */
  /* ================================================================ */
  it('C3-5: X-Active-Center with a non-member center returns 403 ACTIVE_CENTER_INVALID', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/projects')
      .set('Authorization', `Bearer ${centerRepToken}`)
      .set('X-Active-Center', String(C3_UNKNOWN))
      .expect(403);

    const body = res.body as { code: string; statusCode: number };
    expect(body.code).toBe('ACTIVE_CENTER_INVALID');
    expect(body.statusCode).toBe(403);
  });

  /* ================================================================ */
  /* C3-6: No header → defaults to primary center C1                  */
  /* ================================================================ */
  it('C3-6: no X-Active-Center header defaults to primary center (C1 scope)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/projects')
      .set('Authorization', `Bearer ${centerRepToken}`)
      .expect(200);

    const body = res.body as { data: { id: number; centerId: number }[] };
    const ids = body.data.map((p) => p.id);
    expect(ids).toContain(projectC1Id);
    expect(ids).not.toContain(projectC2Id);
  });

  /* ================================================================ */
  /* C3-3: X-Active-Center: C1 → POST /mappings on C1 project → 201  */
  /* ================================================================ */
  it('C3-3: X-Active-Center: C1 — POST /mappings for a C1 project succeeds (201)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/mappings')
      .set('Authorization', `Bearer ${centerRepToken}`)
      .set('X-Active-Center', String(C1))
      .send({
        projectId: projectC1Id,
        programId: PROG_ID,
        allocationPercentage: 100,
        complementarityRating: 'high',
        efficiencyRating: 'high',
      })
      .expect(201);

    expect((res.body as { id: number }).id).toBeGreaterThan(0);
  });

  /* ================================================================ */
  /* C3-4: X-Active-Center: C2 → lock a fully-agreed C2 project      */
  /* ================================================================ */
  it('C3-4: X-Active-Center: C2 — lock a fully-agreed C2 project returns 200', async () => {
    /* Create draft mapping for C2 project. */
    const createRes = await request(app.getHttpServer())
      .post('/api/mappings')
      .set('Authorization', `Bearer ${centerRepToken}`)
      .set('X-Active-Center', String(C2))
      .send({
        projectId: projectC2Id,
        programId: PROG_ID,
        allocationPercentage: 100,
        complementarityRating: 'high',
        efficiencyRating: 'high',
      })
      .expect(201);
    const mappingId = (createRes.body as { id: number }).id;

    /* Open negotiation. */
    await request(app.getHttpServer())
      .post(`/api/mappings/${mappingId}/open`)
      .set('Authorization', `Bearer ${centerRepToken}`)
      .set('X-Active-Center', String(C2))
      .expect(201);

    /* Force-agree both sides directly in the DB (no program_rep
     * seeded for this suite — the lock gate only checks the DB flags,
     * not how they got set). */
    await ds.query(
      `UPDATE project_mappings
         SET status = 'agreed', center_agreed = 1, program_agreed = 1
         WHERE id = ?`,
      [mappingId],
    );

    /* Lock the round as C2 center_rep. */
    await request(app.getHttpServer())
      .post(`/api/mappings/projects/${projectC2Id}/lock`)
      .set('Authorization', `Bearer ${centerRepToken}`)
      .set('X-Active-Center', String(C2))
      .expect(200);

    /* Verify the project is now locked. */
    const rows = await ds.query<{ negotiation_locked: number }[]>(
      `SELECT negotiation_locked FROM projects WHERE id = ?`,
      [projectC2Id],
    );
    expect(rows[0].negotiation_locked).toBe(1);
  });

  /* ================================================================ */
  /* C3-7: X-Active-Center: C1 → exclude a C2 project → 403          */
  /* ================================================================ */
  it('C3-7: X-Active-Center: C1 — POST /projects/:id/exclude on a C2 project returns 403', async () => {
    /* centerId overlay = C1, but projectC2 belongs to C2.
     * The exclusion service checks centerId === project.centerId. */
    await request(app.getHttpServer())
      .post(`/api/projects/${projectC2Id}/exclude`)
      .set('Authorization', `Bearer ${centerRepToken}`)
      .set('X-Active-Center', String(C1))
      .send({ reason: 'C1 center trying to exclude a C2 project' })
      .expect(403);
  });

  /* ================================================================ */
  /* C3-10: Admin PATCH /users/:id → reduces membership to [C2]      */
  /* ================================================================ */
  it('C3-10: PATCH /users/:id with centerIds:[C2] reduces membership to one row, center_id=C2', async () => {
    await request(app.getHttpServer())
      .patch(`/api/users/${centerRepUserId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        role: UserRole.CENTER_REP,
        centerIds: [C2],
      })
      .expect(200);

    const userRows = await ds.query<{ center_id: number }[]>(
      `SELECT center_id FROM users WHERE id = ?`,
      [centerRepUserId],
    );
    expect(userRows[0].center_id).toBe(C2);

    const junctionRows = await ds.query<{ center_id: number }[]>(
      `SELECT center_id FROM user_centers WHERE user_id = ? ORDER BY sort_order ASC`,
      [centerRepUserId],
    );
    expect(junctionRows).toHaveLength(1);
    expect(junctionRows[0].center_id).toBe(C2);
  });

  /* ================================================================ */
  /* C3-11: Non-numeric header → 403 ACTIVE_CENTER_INVALID            */
  /* ================================================================ */
  it('C3-11: X-Active-Center "abc" (non-numeric) returns 403 ACTIVE_CENTER_INVALID', async () => {
    /* centerRepToken still has centerIds=[C1,C2] in its payload (issued
     * before C3-10). The header is rejected at the parse step, before
     * any membership check — so the stale token does not matter here. */
    const res = await request(app.getHttpServer())
      .get('/api/projects')
      .set('Authorization', `Bearer ${centerRepToken}`)
      .set('X-Active-Center', 'abc')
      .expect(403);

    const body = res.body as {
      code: string;
      statusCode: number;
      message: string;
    };
    expect(body.code).toBe('ACTIVE_CENTER_INVALID');
    expect(body.statusCode).toBe(403);
    expect(body.message).toBe('Invalid X-Active-Center header');
  });

  /* ================================================================ */
  /* C3-12: Fresh token (centerIds=[C2]) + X-Active-Center: C1 → 403 */
  /* ================================================================ */
  it('C3-12: fresh token post-revocation with X-Active-Center: C1 (revoked) returns 403 ACTIVE_CENTER_INVALID', async () => {
    /* After C3-10, the user's DB membership is [C2] only.
     * A freshly-issued token now carries centerIds=[C2] in its payload.
     * Sending X-Active-Center: C1 simulates the frontend using a cached
     * active-center value that is no longer valid — the interceptor must
     * reject it with ACTIVE_CENTER_INVALID so the B-6 recovery flow
     * can reset the signal to the new primary. */
    const freshToken = await getToken(app, CENTER_REP_EMAIL);

    const res = await request(app.getHttpServer())
      .get('/api/projects')
      .set('Authorization', `Bearer ${freshToken}`)
      .set('X-Active-Center', String(C1))
      .expect(403);

    const body = res.body as { code: string; statusCode: number };
    expect(body.code).toBe('ACTIVE_CENTER_INVALID');
    expect(body.statusCode).toBe(403);
  });
});
