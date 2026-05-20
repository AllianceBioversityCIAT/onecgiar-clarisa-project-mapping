/**
 * E2E integration tests for the center-rep bulk mappings importer.
 *
 * Endpoints under test:
 *   GET  /api/center-imports/mappings/template
 *   POST /api/center-imports/mappings/validate   (multipart/form-data)
 *   POST /api/center-imports/mappings/commit     (JSON { batchId })
 *
 * Uses real MySQL (docker-compose). All test rows use the `CI-E2E-` prefix
 * on project codes so teardown is deterministic.
 *
 * Centers / programs (always seeded from CLARISA):
 *   C1 = id 1 (AfricaRice)   — the rep's center
 *   C2 = id 2 (BIOVERSITY)   — foreign center used for scoping assertions
 *   P1 = official_code SP01  — "Breeding for Tomorrow"
 *   P2 = official_code SP02  — "Sustainable Farming"
 *   P3 = official_code SP03  — "Sustainable Animal and Aquatic Foods"
 *   P4 = official_code SP04  — fourth program (used to exceed the 3-mapping cap)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import * as ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/modules/users/enums/user-role.enum';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const CODE_PREFIX = 'CI-E2E-';
const C1 = 1; // AfricaRice — center rep's center
const C2 = 2; // BIOVERSITY — foreign center

// Program official codes
const P1 = 'SP01';
const P2 = 'SP02';
const P3 = 'SP03';
const P4 = 'SP04'; // fourth — used to trigger cap

const ADMIN_EMAIL = 'admin@codeobia.com';
const CENTER_REP_EMAIL = 'ci-e2e-center@codeobia.com';
const CENTER_REP_B_EMAIL = 'ci-e2e-center-b@codeobia.com'; // user B for cross-user token test
const PROGRAM_REP_EMAIL = 'ci-e2e-program@codeobia.com';
// P1 is program id 1 (SP01) — the program rep is scoped to it.
const PROGRAM_ID_FOR_REP = 1;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

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
  centerId: number | null,
): Promise<number> {
  await ds.query(
    `UPDATE users SET role = ?, center_id = ?, is_active = 1 WHERE email = ?`,
    [role, centerId, email],
  );
  const rows = await ds.query<{ id: number }[]>(
    `SELECT id FROM users WHERE email = ?`,
    [email],
  );
  return rows[0].id;
}

async function lookupProgramId(
  ds: DataSource,
  officialCode: string,
): Promise<number> {
  const rows = await ds.query<{ id: number }[]>(
    `SELECT id FROM programs WHERE official_code = ?`,
    [officialCode],
  );
  if (!rows[0]) throw new Error(`Program ${officialCode} not found`);
  return rows[0].id;
}

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
  await ds.query(`DELETE FROM projects WHERE code LIKE '${CODE_PREFIX}%'`);
}

/**
 * Build an in-memory .xlsx buffer with the canonical 6-column layout.
 * Each element in `rows` maps to a data row (header is prepended automatically).
 */
async function buildXlsx(
  rows: Array<{
    projectCode: string;
    programCode: string;
    allocation: number | string;
    complementarity: string;
    efficiency: string;
    justification: string;
  }>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Mappings');
  sheet.columns = [
    { header: 'Project Code', key: 'projectCode', width: 20 },
    { header: 'Project Name', key: 'projectName', width: 45 },
    { header: 'Program Code', key: 'programCode', width: 20 },
    { header: 'Allocation %', key: 'allocation', width: 15 },
    { header: 'Complementarity Rating', key: 'complementarity', width: 25 },
    { header: 'Efficiency Rating', key: 'efficiency', width: 20 },
    { header: 'Justification', key: 'justification', width: 50 },
  ];
  for (const r of rows) {
    sheet.addRow({
      projectCode: r.projectCode,
      projectName: '',
      programCode: r.programCode,
      allocation: r.allocation,
      complementarity: r.complementarity,
      efficiency: r.efficiency,
      justification: r.justification,
    });
  }
  const buf = await workbook.xlsx.writeBuffer();
  return buf as unknown as Buffer;
}

/**
 * Build an in-memory .xlsx buffer that mimics the **projects-list export**
 * shape — a "Projects" sheet whose header row matches the export columns
 * the parser keys on (Code at col 2, Program slots at R/V/Z, etc.).
 *
 * Only the columns the parser reads are populated; the rest stay blank to
 * keep the fixture small. Each input row produces one project row with up
 * to three program slots.
 */
async function buildExportXlsx(
  rows: Array<{
    projectCode: string;
    slots: Array<
      | {
          programCode: string;
          allocation: number | string;
          complementarity: string; // 'H' | 'M' | 'L' | ''
          efficiency: string;
        }
      | null
      | undefined
    >;
  }>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Projects');

  // Header row — only the cells the parser inspects need to match exactly.
  const headerRow = sheet.getRow(1);
  headerRow.getCell(2).value = 'Code';
  headerRow.getCell(19).value = 'Program 1';
  headerRow.getCell(20).value = 'Program %';
  headerRow.getCell(21).value = 'Complementarity (HML)';
  headerRow.getCell(22).value = 'Efficiency (HML)';
  headerRow.getCell(23).value = 'Program 2';
  headerRow.getCell(24).value = 'Program %';
  headerRow.getCell(25).value = 'Complementarity (HML)';
  headerRow.getCell(26).value = 'Efficiency (HML)';
  headerRow.getCell(27).value = 'Program 3';
  headerRow.getCell(28).value = 'Program %';
  headerRow.getCell(29).value = 'Complementarity (HML)';
  headerRow.getCell(30).value = 'Efficiency (HML)';
  headerRow.commit();

  let rowIdx = 2;
  for (const r of rows) {
    const dataRow = sheet.getRow(rowIdx);
    dataRow.getCell(2).value = r.projectCode;
    const slotStarts = [19, 23, 27];
    for (let i = 0; i < 3; i++) {
      const s = r.slots[i];
      if (!s) continue;
      const base = slotStarts[i];
      dataRow.getCell(base).value = s.programCode;
      dataRow.getCell(base + 1).value = s.allocation;
      dataRow.getCell(base + 2).value = s.complementarity;
      dataRow.getCell(base + 3).value = s.efficiency;
    }
    dataRow.commit();
    rowIdx++;
  }

  const buf = await workbook.xlsx.writeBuffer();
  return buf as unknown as Buffer;
}

/** POST /validate with a pre-built xlsx buffer. Returns the parsed body. */
async function postValidate(
  app: INestApplication,
  token: string,
  buf: Buffer,
  activeCenterId?: number,
): Promise<request.Response> {
  const req = request(app.getHttpServer())
    .post('/api/center-imports/mappings/validate')
    .set('Authorization', `Bearer ${token}`);
  if (activeCenterId !== undefined) {
    req.set('X-Active-Center', String(activeCenterId));
  }
  return req.attach('file', buf, 'import.xlsx');
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

describe('Center Imports — integration (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let adminToken: string;
  let centerToken: string;
  let centerTokenB: string;
  let programToken: string;
  let centerRepId: number;
  let centerRepBId: number;

  // Project codes created per-test — prefixed with CODE_PREFIX
  let projectCode: string; // single project used across many tests
  let lockedProjectCode: string; // pre-locked project for commit tests

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

    // Pre-clean any leftover rows from a previous failed run.
    await cleanupTestRows(ds);

    // Bootstrap actor tokens.
    adminToken = await getToken(app, ADMIN_EMAIL);
    centerToken = await getToken(app, CENTER_REP_EMAIL);
    centerTokenB = await getToken(app, CENTER_REP_B_EMAIL);
    programToken = await getToken(app, PROGRAM_REP_EMAIL);

    centerRepId = await ensureRole(
      ds,
      CENTER_REP_EMAIL,
      UserRole.CENTER_REP,
      C1,
    );
    centerRepBId = await ensureRole(
      ds,
      CENTER_REP_B_EMAIL,
      UserRole.CENTER_REP,
      C2,
    );

    // Assign program rep to P1 so they can agree on mappings.
    await ds.query(
      `UPDATE users SET role = ?, program_id = ?, center_id = NULL, is_active = 1 WHERE email = ?`,
      [UserRole.PROGRAM_REP, PROGRAM_ID_FOR_REP, PROGRAM_REP_EMAIL],
    );

    // Re-issue so JWT payload reflects the new role/center.
    centerToken = await getToken(app, CENTER_REP_EMAIL);
    centerTokenB = await getToken(app, CENTER_REP_B_EMAIL);
    programToken = await getToken(app, PROGRAM_REP_EMAIL);

    // Create a plain project for the center (C1).
    projectCode = `${CODE_PREFIX}${Date.now()}`;
    await request(app.getHttpServer())
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: projectCode,
        name: 'CI E2E Base Project',
        totalBudget: 500000,
        centerId: C1,
      })
      .expect(201);

    // Create a locked project (C1) with one agreed mapping — for commit-path tests.
    lockedProjectCode = `${CODE_PREFIX}LOCKED-${Date.now()}`;
    const lockedRes = await request(app.getHttpServer())
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: lockedProjectCode,
        name: 'CI E2E Locked Project',
        totalBudget: 200000,
        centerId: C1,
      })
      .expect(201);
    const lockedProjectId = (lockedRes.body as { id: number }).id;

    // Seed a mapping on the locked project so we can lock the round.
    const p1Id = await lookupProgramId(ds, P1);
    const mapRes = await request(app.getHttpServer())
      .post('/api/mappings')
      .set('Authorization', `Bearer ${centerToken}`)
      .send({
        projectId: lockedProjectId,
        programId: p1Id,
        allocationPercentage: 100,
        complementarityRating: 'high',
        efficiencyRating: 'medium',
      })
      .expect(201);
    const mapId = (mapRes.body as { id: number }).id;

    // Open negotiation so it is visible to program rep.
    await request(app.getHttpServer())
      .post(`/api/mappings/${mapId}/open`)
      .set('Authorization', `Bearer ${centerToken}`)
      .expect(201);

    // Both sides must agree before locking.
    await request(app.getHttpServer())
      .post(`/api/mappings/${mapId}/agree`)
      .set('Authorization', `Bearer ${centerToken}`)
      .send({})
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/mappings/${mapId}/agree`)
      .set('Authorization', `Bearer ${programToken}`)
      .send({})
      .expect(201);

    // Lock the project round (returns 200, not 201 — see mappings.controller.ts).
    await request(app.getHttpServer())
      .post(`/api/mappings/projects/${lockedProjectId}/lock`)
      .set('Authorization', `Bearer ${centerToken}`)
      .expect(200);
  }, 60_000);

  afterAll(async () => {
    await cleanupTestRows(ds);
    await ds.query(
      `UPDATE users SET role = NULL, center_id = NULL, program_id = NULL WHERE email IN (?, ?, ?)`,
      [CENTER_REP_EMAIL, CENTER_REP_B_EMAIL, PROGRAM_REP_EMAIL],
    );
    await app.close();
  });

  /* ================================================================ */
  /* 1. Template download                                              */
  /* ================================================================ */

  describe('GET /center-imports/mappings/template', () => {
    it('returns 200, xlsx content-type, non-empty body for center_rep', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/center-imports/mappings/template')
        .set('Authorization', `Bearer ${centerToken}`)
        .expect(200);

      expect(res.headers['content-type']).toMatch(
        /openxmlformats-officedocument\.spreadsheetml\.sheet/,
      );
      expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
      expect(res.body).toBeDefined();
    });

    it('returns 403 for admin role (admin is read-only on negotiation surface)', async () => {
      await request(app.getHttpServer())
        .get('/api/center-imports/mappings/template')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
    });
  });

  /* ================================================================ */
  /* 2. Validate — happy path                                          */
  /* ================================================================ */

  describe('POST /validate — happy path', () => {
    it('returns 200, summary.errors === 0, batchId present, preview shape correct', async () => {
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 60,
          complementarity: 'high',
          efficiency: 'medium',
          justification: 'Justification for P1 allocation',
        },
        {
          projectCode,
          programCode: P2,
          allocation: 40,
          complementarity: 'medium',
          efficiency: 'low',
          justification: 'Justification for P2 allocation',
        },
      ]);

      const res = await postValidate(app, centerToken, buf);
      expect(res.status).toBe(200);

      const body = res.body as {
        batchId: string;
        summary: {
          toCreate: number;
          toUpdate: number;
          toRemove: number;
          errors: number;
        };
        errors: unknown[];
        preview: {
          toCreate: unknown[];
          toUpdate: unknown[];
          toRemove: unknown[];
        };
      };

      expect(body.summary.errors).toBe(0);
      expect(body.batchId).toBeDefined();
      expect(typeof body.batchId).toBe('string');
      expect(body.errors).toHaveLength(0);
      expect(body.preview.toCreate).toHaveLength(2);
      expect(body.preview.toUpdate).toHaveLength(0);
      expect(body.preview.toRemove).toHaveLength(0);
      expect(body.summary.toCreate).toBe(2);
    });
  });

  /* ================================================================ */
  /* 3. Validate — error cases                                         */
  /* ================================================================ */

  describe('POST /validate — error cases', () => {
    async function expectError(
      buf: Buffer,
      matcher: (
        errors: Array<{
          row: number;
          projectCode: string;
          programCode: string;
          message: string;
        }>,
      ) => void,
    ) {
      const res = await postValidate(app, centerToken, buf);
      expect(res.status).toBe(200);
      const body = res.body as {
        batchId?: string;
        summary: { errors: number };
        errors: Array<{
          row: number;
          projectCode: string;
          programCode: string;
          message: string;
        }>;
      };
      expect(body.summary.errors).toBeGreaterThan(0);
      expect(body.batchId).toBeUndefined();
      matcher(body.errors);
    }

    it('allocation sum > 100% → error, no batchId', async () => {
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 70,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Valid justification text',
        },
        {
          projectCode,
          programCode: P2,
          allocation: 50, // 70+50 = 120%
          complementarity: 'medium',
          efficiency: 'medium',
          justification: 'Valid justification text',
        },
      ]);
      await expectError(buf, (errors) => {
        const sumError = errors.find((e) => e.message.includes('sum'));
        expect(sumError).toBeDefined();
      });
    });

    it('invalid complementarity rating → error with row number', async () => {
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 100,
          complementarity: 'excellent', // invalid
          efficiency: 'high',
          justification: 'Valid justification text',
        },
      ]);
      await expectError(buf, (errors) => {
        const ratingErr = errors.find((e) =>
          e.message.toLowerCase().includes('complementarity'),
        );
        expect(ratingErr).toBeDefined();
        expect(ratingErr!.row).toBe(2); // row 2 = first data row
      });
    });

    it('invalid efficiency rating → error', async () => {
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 100,
          complementarity: 'high',
          efficiency: 'great', // invalid
          justification: 'Valid justification text',
        },
      ]);
      await expectError(buf, (errors) => {
        expect(
          errors.some((e) => e.message.toLowerCase().includes('efficiency')),
        ).toBe(true);
      });
    });

    it('justification missing (empty) → null on the row, no error', async () => {
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 100,
          complementarity: 'high',
          efficiency: 'high',
          justification: '', // missing — should null out rather than fail
        },
      ]);
      const res = await postValidate(app, centerToken, buf);
      expect(res.status).toBe(200);
      expect(res.body.summary.errors).toBe(0);
      expect(res.body.batchId).toBeTruthy();
      const created = (
        res.body.preview.toCreate as Array<{
          programCode: string;
          justification: string | null;
        }>
      ).find((r) => r.programCode === P1);
      expect(created?.justification).toBeNull();
    });

    it('justification shorter than 10 chars → error', async () => {
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 100,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Short',
        },
      ]);
      await expectError(buf, (errors) => {
        expect(
          errors.some((e) => e.message.toLowerCase().includes('justification')),
        ).toBe(true);
      });
    });

    it('project code not in DB → error', async () => {
      const buf = await buildXlsx([
        {
          projectCode: 'DOES-NOT-EXIST-XYZ',
          programCode: P1,
          allocation: 100,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Valid justification text',
        },
      ]);
      await expectError(buf, (errors) => {
        expect(
          errors.some(
            (e) =>
              e.projectCode === 'DOES-NOT-EXIST-XYZ' ||
              e.message.toLowerCase().includes('not found'),
          ),
        ).toBe(true);
      });
    });

    it('project belongs to a different center → error (scoping)', async () => {
      // Create a project in C2 (BIOVERSITY), then try to import it as C1 rep.
      const foreignCode = `${CODE_PREFIX}FOREIGN-${Date.now()}`;
      await request(app.getHttpServer())
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: foreignCode,
          name: 'Foreign Center Project',
          totalBudget: 100000,
          centerId: C2,
        })
        .expect(201);

      const buf = await buildXlsx([
        {
          projectCode: foreignCode,
          programCode: P1,
          allocation: 100,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Valid justification text',
        },
      ]);

      await expectError(buf, (errors) => {
        expect(
          errors.some(
            (e) =>
              e.projectCode === foreignCode ||
              e.message.toLowerCase().includes('center'),
          ),
        ).toBe(true);
      });
    });

    it('program code not in DB → error', async () => {
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: 'NOTAPROGRAM',
          allocation: 100,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Valid justification text',
        },
      ]);
      await expectError(buf, (errors) => {
        expect(
          errors.some(
            (e) =>
              e.programCode === 'NOTAPROGRAM' ||
              e.message.toLowerCase().includes('program'),
          ),
        ).toBe(true);
      });
    });

    it('> 3 mappings per project → 3-mapping cap error, no batchId', async () => {
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 25,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Valid justification text',
        },
        {
          projectCode,
          programCode: P2,
          allocation: 25,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Valid justification text',
        },
        {
          projectCode,
          programCode: P3,
          allocation: 25,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Valid justification text',
        },
        {
          projectCode,
          programCode: P4, // 4th row — exceeds cap
          allocation: 25,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Valid justification text',
        },
      ]);
      const res = await postValidate(app, centerToken, buf);
      expect(res.status).toBe(200);
      const body = res.body as {
        batchId?: string;
        summary: { errors: number };
        errors: Array<{ message: string }>;
      };
      expect(body.batchId).toBeUndefined();
      expect(body.summary.errors).toBeGreaterThan(0);
      expect(
        body.errors.some(
          (e) => e.message.includes('maximum') || e.message.includes('3'),
        ),
      ).toBe(true);
    });
  });

  /* ================================================================ */
  /* 4. Validate — sum < 100% should be a WARNING, not a hard error   */
  /* ================================================================ */

  describe('POST /validate — sum < 100% warning behavior', () => {
    it('sum < 100% returns batchId (warning path, not an error)', async () => {
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 50, // only 50% — incomplete but not forbidden
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Valid justification text here',
        },
      ]);
      const res = await postValidate(app, centerToken, buf);
      expect(res.status).toBe(200);
      const body = res.body as {
        batchId?: string;
        summary: { errors: number };
      };
      // Sum < 100% must NOT be a hard error — batchId must be present.
      // BUG DETECTION: if this fails, the service treats <100% as an error.
      expect(body.summary.errors).toBe(0);
      expect(body.batchId).toBeDefined();
    });
  });

  /* ================================================================ */
  /* 5. Validate — removal warning path                               */
  /* ================================================================ */

  describe('POST /validate — omitted mapping appears in toRemove', () => {
    it('file omitting an existing mapping → preview.toRemove populated, no error', async () => {
      // First commit a mapping for P1 and P2 on projectCode.
      const setupBuf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 60,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Setup justification text here',
        },
        {
          projectCode,
          programCode: P2,
          allocation: 40,
          complementarity: 'medium',
          efficiency: 'medium',
          justification: 'Setup justification text here',
        },
      ]);
      const setupValidate = await postValidate(app, centerToken, setupBuf);
      expect(setupValidate.body.summary.errors).toBe(0);
      const setupBatchId = (setupValidate.body as { batchId: string }).batchId;
      await request(app.getHttpServer())
        .post('/api/center-imports/mappings/commit')
        .set('Authorization', `Bearer ${centerToken}`)
        .send({ batchId: setupBatchId })
        .expect(200);

      // Now upload a file with only P1 — P2 should appear in toRemove.
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 100,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Updated justification text here',
        },
      ]);
      const res = await postValidate(app, centerToken, buf);
      expect(res.status).toBe(200);
      const body = res.body as {
        batchId?: string;
        summary: { toRemove: number; errors: number };
        preview: {
          toRemove: Array<{ projectCode: string; programCode: string }>;
        };
      };
      expect(body.summary.errors).toBe(0);
      expect(body.batchId).toBeDefined();
      expect(body.summary.toRemove).toBe(1);
      expect(body.preview.toRemove).toHaveLength(1);
      expect(body.preview.toRemove[0].projectCode).toBe(projectCode);
      expect(body.preview.toRemove[0].programCode).toBe(P2);
    });
  });

  /* ================================================================ */
  /* 6. Commit — full lifecycle on a locked project                   */
  /* ================================================================ */

  describe('POST /commit — full lifecycle', () => {
    let batchId: string;
    let p1Id: number;
    let p2Id: number;
    let lockedProjectId: number;

    beforeAll(async () => {
      const rows = await ds.query<{ id: number }[]>(
        `SELECT id FROM projects WHERE code = ?`,
        [lockedProjectCode],
      );
      lockedProjectId = rows[0].id;

      p1Id = await lookupProgramId(ds, P1);
      p2Id = await lookupProgramId(ds, P2);

      // File: keep P1 with a new allocation, add P2 as new, omit nothing
      // (P1 was the only existing mapping before the lock).
      const buf = await buildXlsx([
        {
          projectCode: lockedProjectCode,
          programCode: P1,
          allocation: 60,
          complementarity: 'medium',
          efficiency: 'low',
          justification: 'Revised allocation after reopen via import',
        },
        {
          projectCode: lockedProjectCode,
          programCode: P2,
          allocation: 40,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Adding new program via bulk import',
        },
      ]);

      const res = await postValidate(app, centerToken, buf);
      expect(res.body.summary.errors).toBe(0);
      batchId = (res.body as { batchId: string }).batchId;
    });

    it('commit returns 200 with imported + projectsAffected counts', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/center-imports/mappings/commit')
        .set('Authorization', `Bearer ${centerToken}`)
        .send({ batchId })
        .expect(200);

      const body = res.body as {
        imported: number;
        removed: number;
        projectsAffected: number;
      };
      expect(body.projectsAffected).toBe(1);
      expect(body.imported).toBeGreaterThanOrEqual(1); // at least the update
    });

    it('project is now negotiation_locked = false (was reopened)', async () => {
      const rows = await ds.query<{ negotiation_locked: number }[]>(
        `SELECT negotiation_locked FROM projects WHERE id = ?`,
        [lockedProjectId],
      );
      expect(rows[0].negotiation_locked).toBe(0);
    });

    it('P1 mapping is in negotiating status with updated allocation + ratings', async () => {
      const rows = await ds.query<
        {
          status: string;
          allocation_percentage: string;
          complementarity_rating: string;
          efficiency_rating: string;
        }[]
      >(
        `SELECT status, allocation_percentage, complementarity_rating, efficiency_rating
           FROM project_mappings
           WHERE project_id = ? AND program_id = ? AND status != 'removed'`,
        [lockedProjectId, p1Id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('negotiating');
      expect(Number(rows[0].allocation_percentage)).toBe(60);
      expect(rows[0].complementarity_rating).toBe('medium');
      expect(rows[0].efficiency_rating).toBe('low');
    });

    it('P2 new mapping is in negotiating status', async () => {
      const rows = await ds.query<
        { status: string; allocation_percentage: string }[]
      >(
        `SELECT status, allocation_percentage
           FROM project_mappings
           WHERE project_id = ? AND program_id = ? AND status != 'removed'`,
        [lockedProjectId, p2Id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('negotiating');
      expect(Number(rows[0].allocation_percentage)).toBe(40);
    });

    it('importer-written events carry actor_id = centerRepId, NOT system user', async () => {
      // This is the primary attribution invariant for the feature.
      // We only check events written by the importer itself — the pre-commit
      // lock setup also wrote events (agreed by programToken, locked by
      // centerToken) which are expected to carry those actors' ids.
      // Importer-written event types: reopened, counter_proposed, initiated,
      // negotiation_started.
      const systemUser = await ds.query<{ id: number }[]>(
        `SELECT id FROM users WHERE email = 'system@prms.cgiar.org'`,
      );
      const systemUserId = systemUser[0]?.id ?? -1;

      const importerEventTypes = [
        'reopened',
        'counter_proposed',
        'initiated',
        'negotiation_started',
      ];
      const placeholders = importerEventTypes.map(() => '?').join(', ');

      const events = await ds.query<{ actor_id: number; event_type: string }[]>(
        `SELECT n.actor_id, n.event_type
           FROM mapping_negotiations n
           INNER JOIN project_mappings m ON m.id = n.mapping_id
           WHERE m.project_id = ?
             AND n.event_type IN (${placeholders})
           ORDER BY n.id ASC`,
        [lockedProjectId, ...importerEventTypes],
      );

      // Must have events from the import.
      expect(events.length).toBeGreaterThan(0);

      // Every importer event must be attributed to the uploading center rep.
      for (const ev of events) {
        expect(ev.actor_id).toBe(centerRepId);
      }

      // No importer event attributed to the synthetic system user.
      const systemEvents = events.filter((e) => e.actor_id === systemUserId);
      expect(systemEvents).toHaveLength(0);
    });

    it('P1 counter_proposed event carries correct justification', async () => {
      const rows = await ds.query<
        { justification: string; event_type: string }[]
      >(
        `SELECT n.event_type, n.justification
           FROM mapping_negotiations n
           INNER JOIN project_mappings m ON m.id = n.mapping_id
           WHERE m.project_id = ? AND m.program_id = ?
           ORDER BY n.id ASC`,
        [lockedProjectId, p1Id],
      );
      const counterEvent = rows.find(
        (r) => r.event_type === 'counter_proposed',
      );
      expect(counterEvent).toBeDefined();
      expect(counterEvent!.justification).toBe(
        'Revised allocation after reopen via import',
      );
    });

    it('P2 initiated event carries correct justification', async () => {
      const rows = await ds.query<
        { justification: string; event_type: string }[]
      >(
        `SELECT n.event_type, n.justification
           FROM mapping_negotiations n
           INNER JOIN project_mappings m ON m.id = n.mapping_id
           WHERE m.project_id = ? AND m.program_id = ?
           ORDER BY n.id ASC`,
        [lockedProjectId, p2Id],
      );
      const initiatedEvent = rows.find((r) => r.event_type === 'initiated');
      expect(initiatedEvent).toBeDefined();
      expect(initiatedEvent!.justification).toBe(
        'Adding new program via bulk import',
      );
    });
  });

  /* ================================================================ */
  /* 7. Commit — guards                                               */
  /* ================================================================ */

  describe('POST /commit — guards', () => {
    it('invalid / forged batchId → 400', async () => {
      await request(app.getHttpServer())
        .post('/api/center-imports/mappings/commit')
        .set('Authorization', `Bearer ${centerToken}`)
        .send({ batchId: 'not.a.valid.jwt.at.all' })
        .expect(400);
    });

    it('replay: committing the same batchId twice → second call fails with 400', async () => {
      // Use projectCode (C1). Validate a fresh batch.
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 100,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Replay guard test justification',
        },
      ]);
      const validateRes = await postValidate(app, centerToken, buf);
      expect(validateRes.body.summary.errors).toBe(0);
      const { batchId } = validateRes.body as { batchId: string };

      // First commit succeeds.
      await request(app.getHttpServer())
        .post('/api/center-imports/mappings/commit')
        .set('Authorization', `Bearer ${centerToken}`)
        .send({ batchId })
        .expect(200);

      // Second commit with same batchId → session evicted → 400.
      await request(app.getHttpServer())
        .post('/api/center-imports/mappings/commit')
        .set('Authorization', `Bearer ${centerToken}`)
        .send({ batchId })
        .expect(400);
    });

    it('file validated by user A, committed by user B → 403', async () => {
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 100,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Cross-user guard test justification',
        },
      ]);
      // User A (centerToken, C1) validates.
      const validateRes = await postValidate(app, centerToken, buf);
      expect(validateRes.body.summary.errors).toBe(0);
      const { batchId } = validateRes.body as { batchId: string };

      // User B (centerTokenB, C2) tries to commit — different actor → 403.
      await request(app.getHttpServer())
        .post('/api/center-imports/mappings/commit')
        .set('Authorization', `Bearer ${centerTokenB}`)
        .send({ batchId })
        .expect(403);
    });

    it('missing batchId in body → 400 (ValidationPipe)', async () => {
      await request(app.getHttpServer())
        .post('/api/center-imports/mappings/commit')
        .set('Authorization', `Bearer ${centerToken}`)
        .send({})
        .expect(400);
    });
  });

  /* ================================================================ */
  /* 8. Commit — removal of omitted mapping                           */
  /* ================================================================ */

  describe('POST /commit — mapping removal via omission', () => {
    it('active (negotiating) mapping omitted from file → removed status + REMOVED event appended', async () => {
      // Create a fresh project with two mappings: P1 and P2, both agreed.
      const removalCode = `${CODE_PREFIX}REMOVAL-${Date.now()}`;
      const projRes = await request(app.getHttpServer())
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: removalCode,
          name: 'CI E2E Removal Test Project',
          totalBudget: 100000,
          centerId: C1,
        })
        .expect(201);
      const removalProjectId = (projRes.body as { id: number }).id;

      const p1Id = await lookupProgramId(ds, P1);
      const p2Id = await lookupProgramId(ds, P2);

      // Create P1 mapping.
      const m1Res = await request(app.getHttpServer())
        .post('/api/mappings')
        .set('Authorization', `Bearer ${centerToken}`)
        .send({
          projectId: removalProjectId,
          programId: p1Id,
          allocationPercentage: 60,
          complementarityRating: 'high',
          efficiencyRating: 'high',
        })
        .expect(201);
      const m1Id = (m1Res.body as { id: number }).id;

      // Create P2 mapping.
      const m2Res = await request(app.getHttpServer())
        .post('/api/mappings')
        .set('Authorization', `Bearer ${centerToken}`)
        .send({
          projectId: removalProjectId,
          programId: p2Id,
          allocationPercentage: 40,
          complementarityRating: 'medium',
          efficiencyRating: 'medium',
        })
        .expect(201);
      const m2Id = (m2Res.body as { id: number }).id;

      // Open both into negotiating state — that's sufficient for the importer
      // to detect and remove them; full two-sided agree is not required.
      await request(app.getHttpServer())
        .post(`/api/mappings/${m1Id}/open`)
        .set('Authorization', `Bearer ${centerToken}`)
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/mappings/${m2Id}/open`)
        .set('Authorization', `Bearer ${centerToken}`)
        .expect(201);

      // Now upload a file with only P1 — P2 omitted.
      const buf = await buildXlsx([
        {
          projectCode: removalCode,
          programCode: P1,
          allocation: 100,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Removal test justification here',
        },
      ]);
      const validateRes = await postValidate(app, centerToken, buf);
      expect(validateRes.body.summary.errors).toBe(0);
      expect(validateRes.body.preview.toRemove).toHaveLength(1);
      const { batchId } = validateRes.body as { batchId: string };

      await request(app.getHttpServer())
        .post('/api/center-imports/mappings/commit')
        .set('Authorization', `Bearer ${centerToken}`)
        .send({ batchId })
        .expect(200);

      // P2 mapping must now be removed.
      const p2Mapping = await ds.query<{ status: string }[]>(
        `SELECT status FROM project_mappings WHERE id = ?`,
        [m2Id],
      );
      expect(p2Mapping[0].status).toBe('removed');

      // A REMOVED event must be the last event on P2's timeline,
      // attributed to the uploading center rep (not system).
      const p2Events = await ds.query<
        { event_type: string; actor_id: number }[]
      >(
        `SELECT event_type, actor_id FROM mapping_negotiations
           WHERE mapping_id = ? ORDER BY id DESC LIMIT 1`,
        [m2Id],
      );
      expect(p2Events[0].event_type).toBe('removed');
      expect(p2Events[0].actor_id).toBe(centerRepId);
    });
  });

  /* ================================================================ */
  /* 9. Center scoping — rep from center A cannot import project B    */
  /* ================================================================ */

  describe('Center scoping', () => {
    it('center B rep validating a project in center A → row-level error', async () => {
      // projectCode belongs to C1; centerTokenB is for C2.
      const buf = await buildXlsx([
        {
          projectCode,
          programCode: P1,
          allocation: 100,
          complementarity: 'high',
          efficiency: 'high',
          justification: 'Valid justification text here',
        },
      ]);
      const res = await postValidate(app, centerTokenB, buf);
      expect(res.status).toBe(200);
      const body = res.body as {
        summary: { errors: number };
        batchId?: string;
      };
      expect(body.summary.errors).toBeGreaterThan(0);
      expect(body.batchId).toBeUndefined();
    });
  });

  /* ================================================================ */
  /* 10. No file uploaded → graceful 200 with error message           */
  /* ================================================================ */

  describe('POST /validate — no file', () => {
    it('missing file returns 200 with error message (not a 500)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/center-imports/mappings/validate')
        .set('Authorization', `Bearer ${centerToken}`)
        // no .attach('file', ...)
        .expect(200);

      const body = res.body as {
        summary: { errors: number };
        errors: Array<{ message: string }>;
      };
      expect(body.summary.errors).toBeGreaterThan(0);
      expect(body.errors[0].message).toMatch(/xlsx/i);
    });
  });

  /* ================================================================ */
  /* 11. Wide-format (projects-export) parsing                         */
  /* ================================================================ */

  describe('POST /validate — projects-export "Projects" sheet format', () => {
    // Each test creates its own project so it isn't polluted by mappings
    // committed earlier in the suite.
    let exportProjectCode: string;

    beforeEach(async () => {
      exportProjectCode = `${CODE_PREFIX}EXP-${Date.now()}-${Math.floor(
        Math.random() * 1000,
      )}`;
      await request(app.getHttpServer())
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: exportProjectCode,
          name: 'CI E2E Export-Format Project',
          totalBudget: 100000,
          centerId: C1,
        })
        .expect(201);
    });

    afterEach(async () => {
      await ds.query(`DELETE FROM projects WHERE code = ?`, [
        exportProjectCode,
      ]);
    });

    it('parses a single project row with one slot → 1 toCreate, no errors', async () => {
      const buf = await buildExportXlsx([
        {
          projectCode: exportProjectCode,
          slots: [
            {
              programCode: P1,
              allocation: 100,
              complementarity: 'H',
              efficiency: 'M',
            },
          ],
        },
      ]);
      const res = await postValidate(app, centerToken, buf);
      expect(res.status).toBe(200);
      const body = res.body as {
        summary: { errors: number; toCreate: number };
        batchId?: string;
        preview: {
          toCreate: Array<{
            programCode: string;
            complementarityRating: string;
            efficiencyRating: string;
            justification: string | null;
          }>;
        };
      };
      expect(body.summary.errors).toBe(0);
      expect(body.batchId).toBeTruthy();
      expect(body.summary.toCreate).toBe(1);
      const created = body.preview.toCreate[0];
      expect(created.programCode).toBe(P1);
      // H/M/L letters from the export must normalize to full words.
      expect(created.complementarityRating).toBe('high');
      expect(created.efficiencyRating).toBe('medium');
      // Export has no Justification column → null on the row.
      expect(created.justification).toBeNull();
    });

    it('parses two filled slots and skips the empty third slot', async () => {
      const buf = await buildExportXlsx([
        {
          projectCode: exportProjectCode,
          slots: [
            {
              programCode: P1,
              allocation: 60,
              complementarity: 'H',
              efficiency: 'H',
            },
            {
              programCode: P2,
              allocation: 40,
              complementarity: 'M',
              efficiency: 'L',
            },
            null, // empty slot 3 — must not produce a row
          ],
        },
      ]);
      const res = await postValidate(app, centerToken, buf);
      expect(res.status).toBe(200);
      const body = res.body as {
        summary: { errors: number; toCreate: number };
        preview: { toCreate: Array<{ programCode: string }> };
      };
      expect(body.summary.errors).toBe(0);
      expect(body.summary.toCreate).toBe(2);
      const codes = body.preview.toCreate.map((r) => r.programCode).sort();
      expect(codes).toEqual([P1, P2].sort());
    });

    it("row for a project that does not belong to the rep's center → error", async () => {
      // Create a foreign-center project through the API so all required
      // columns (incl. created_by) are populated.
      const foreignProjectCode = `${CODE_PREFIX}FOREIGN-${Date.now()}-${Math.floor(
        Math.random() * 1000,
      )}`;
      await request(app.getHttpServer())
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: foreignProjectCode,
          name: 'CI E2E Foreign Project',
          totalBudget: 50000,
          centerId: C2,
        })
        .expect(201);

      const buf = await buildExportXlsx([
        {
          projectCode: foreignProjectCode,
          slots: [
            {
              programCode: P1,
              allocation: 100,
              complementarity: 'H',
              efficiency: 'H',
            },
          ],
        },
      ]);
      const res = await postValidate(app, centerToken, buf);
      expect(res.status).toBe(200);
      const body = res.body as {
        summary: { errors: number };
        batchId?: string;
        errors: Array<{ message: string }>;
      };
      expect(body.summary.errors).toBeGreaterThan(0);
      expect(body.batchId).toBeUndefined();
      expect(
        body.errors.some((e) =>
          /not found|does not belong/i.test(e.message),
        ),
      ).toBe(true);

      // cleanup
      await ds.query(`DELETE FROM projects WHERE code = ?`, [
        foreignProjectCode,
      ]);
    });

    it('rejects a file whose "Projects" sheet header does not match the export', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Projects');
      // Wrong headers — should be caught by the schema check.
      sheet.getRow(1).getCell(2).value = 'WRONG_HEADER';
      sheet.getRow(1).commit();
      const buf = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
      const res = await postValidate(app, centerToken, buf);
      // BadRequestException from parseExcel → 400 (not 200 with error body).
      expect(res.status).toBe(400);
    });
  });
});
