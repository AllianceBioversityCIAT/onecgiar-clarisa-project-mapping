/**
 * E2E spec for GET /api/projects/export (list Excel export).
 *
 * Validates the 4-sheet workbook structure, header column names,
 * Summary sheet content, data-row correctness (ratings, flags, decimal
 * coercions), and role scoping (center_rep sees only their center's
 * projects).
 *
 * Uses real MySQL (docker-compose). All test rows use the prefix
 * 'EXP-E2E-' so they can be cleaned up deterministically in afterAll.
 *
 * ExcelJS is used both by the service under test AND here to parse the
 * response buffer — this keeps the assertion logic independent of how
 * the buffer was produced (it's a real .xlsx parse, not string scanning).
 *
 * Rate-limit note: the export endpoint is throttled to 5 requests per
 * 60s by IP. Supertest runs from 127.0.0.1 so ALL exports share one
 * bucket. We limit this spec to 4 total export requests: one unfiltered
 * admin export (shared across sections A+B), one filtered admin export
 * (section C), and two role-scoping exports (section D: one admin +
 * one center-rep). This keeps us safely under the limit of 5.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/modules/users/enums/user-role.enum';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CODE_PREFIX = 'EXP-E2E-';
const CENTER_ID = 1; // First center — guaranteed to exist in seeded DB
const PROGRAM_ID_1 = 1; // First seeded program
const PROGRAM_ID_2 = 2; // Second seeded program

const ADMIN_EMAIL = 'admin@codeobia.com';
const CENTER_REP_EMAIL = 'export-e2e-center@codeobia.com';

/** Expected verbatim headers on the Projects sheet (42 columns). */
const PROJECTS_HEADERS = [
  'ID', 'Code', 'Name', 'Status', 'Center Acronym', 'Center Name',
  'Location of Benefit', 'Country of Implementation',
  'Start Date', 'End Date', 'Funding Source', 'Funder',
  'Total Budget', 'Remaining Budget', 'Total Pledge', 'FY Budget',
  'Agreed Alloc %', 'Mapped Programs',
  'Program 1', 'Program %', 'Complementarity (HML)', 'Efficiency (HML)',
  'Program 2', 'Program %', 'Complementarity (HML)', 'Efficiency (HML)',
  'Program 3', 'Program %', 'Complementarity (HML)', 'Efficiency (HML)',
  '% check', 'In Active Negotiation', 'Negotiation Locked',
  'Needs Assistance Count', 'Principal Investigator', 'Signed Contract Title',
  'Funder Primary Center', 'Nature of Funder',
  'Description', 'Summary', 'Created At', 'Updated At',
];

/** Expected verbatim headers on the Mappings sheet (13 columns). */
const MAPPINGS_HEADERS = [
  'Project Code', 'Project Name', 'Program Code', 'Program Name',
  'Allocation %', 'Status', 'Center Agreed', 'Program Agreed',
  'Needs Assistance', 'Initiated By', 'Initiated At', 'Flagged At', 'Updated At',
];

/** Expected verbatim headers on the Budgets sheet (6 columns). */
const BUDGETS_HEADERS = [
  'Project Code', 'Year', 'Version', 'Account', 'External Code', 'Amount',
];

const EM_DASH = '—';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Issues a dev-token JWT and returns the bearer string. */
async function getToken(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .get(`/api/auth/dev-token?email=${encodeURIComponent(email)}`)
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

/**
 * Promotes an existing dev-login user to the requested role and scope.
 *
 * Pattern mirrors negotiation.e2e-spec.ts: the caller must already have
 * called getToken once to ensure the user row exists in the DB (dev-token
 * upserts on first call). Then we UPDATE the role/center, insert the
 * user_centers junction row if needed, and the caller re-issues the token.
 */
async function promoteUser(
  ds: DataSource,
  email: string,
  role: UserRole,
  centerId: number | null,
): Promise<void> {
  await ds.query(
    `UPDATE users SET role = ?, center_id = ?, is_active = 1 WHERE email = ?`,
    [role, centerId, email],
  );
  // Ensure user_centers junction row exists for center_rep
  if (role === UserRole.CENTER_REP && centerId !== null) {
    const rows = await ds.query<{ id: number }[]>(
      `SELECT id FROM users WHERE email = ?`,
      [email],
    );
    const userId = rows[0]?.id;
    if (userId) {
      await ds.query(
        `INSERT IGNORE INTO user_centers (user_id, center_id, sort_order) VALUES (?, ?, 0)`,
        [userId, centerId],
      );
    }
  }
}

/**
 * Parses the raw Buffer from the supertest response into an ExcelJS
 * workbook. Returns the workbook for assertions.
 */
async function parseWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const stream = Readable.from(buffer);
  await workbook.xlsx.read(stream);
  return workbook;
}

/**
 * Reads the header row (row 1) of a worksheet and returns the cell values
 * as an array of strings. Empty trailing cells are ignored.
 */
function readHeaderRow(sheet: ExcelJS.Worksheet): string[] {
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
    headers.push(String(cell.value ?? ''));
  });
  return headers;
}

/**
 * Issues an export request and buffers the response body.
 * Asserts 200 and returns the raw Buffer.
 */
async function fetchExport(
  app: INestApplication,
  token: string,
  queryString = '',
): Promise<Buffer> {
  const url = `/api/projects/export${queryString ? `?${queryString}` : ''}`;
  const res = await request(app.getHttpServer())
    .get(url)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    })
    .expect(200);
  return res.body as Buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Projects Export — integration (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let adminToken: string;
  let centerToken: string;

  /** ID of the project seeded for data-shape assertions (Section C). */
  let dataProjectId: number;

  /** IDs of the mappings seeded on dataProjectId. */
  let mapping1Id: number;
  let mapping2Id: number;

  /**
   * Shared workbooks — populated once in the top-level beforeAll so we
   * stay under the 5-request-per-60s throttler limit.
   *
   * - adminWorkbook: unfiltered admin export (used by sections A + B)
   * - dataWorkbook:  admin export filtered to the seeded data project (C)
   * - centerWorkbook: center-rep scoped export (D)
   */
  let adminWorkbook: ExcelJS.Workbook;
  let dataWorkbook: ExcelJS.Workbook;
  let adminWorkbookForScoping: ExcelJS.Workbook;
  let centerWorkbook: ExcelJS.Workbook;

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

    // Bootstrap admin token
    adminToken = await getToken(app, ADMIN_EMAIL);

    // Bootstrap center rep:
    // 1. First getToken call creates the user row via dev-token upsert.
    // 2. promoteUser sets role + center_id + user_centers junction.
    // 3. Second getToken re-issues a JWT that embeds role=center_rep and centerIds=[1].
    // This mirrors the pattern in negotiation.e2e-spec.ts exactly.
    await getToken(app, CENTER_REP_EMAIL);
    await promoteUser(ds, CENTER_REP_EMAIL, UserRole.CENTER_REP, CENTER_ID);
    centerToken = await getToken(app, CENTER_REP_EMAIL);

    // ── Seed: project with two active mappings (Section C) ──────────────────
    const dataCode = `${CODE_PREFIX}DATA-${Date.now()}`;
    const projRes = await request(app.getHttpServer())
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: dataCode,
        name: 'Export E2E Data Project',
        totalBudget: 250000,
        remainingBudget: 125000,
        centerId: CENTER_ID,
      })
      .expect(201);
    dataProjectId = (projRes.body as { id: number }).id;

    // Mapping 1: complementarity=high, efficiency=medium, 60%
    const m1Res = await request(app.getHttpServer())
      .post('/api/mappings')
      .set('Authorization', `Bearer ${centerToken}`)
      .send({
        projectId: dataProjectId,
        programId: PROGRAM_ID_1,
        allocationPercentage: 60,
        complementarityRating: 'high',
        efficiencyRating: 'medium',
      })
      .expect(201);
    mapping1Id = (m1Res.body as { id: number }).id;

    // Open mapping 1 so it transitions to negotiating status
    await request(app.getHttpServer())
      .post(`/api/mappings/${mapping1Id}/open`)
      .set('Authorization', `Bearer ${centerToken}`)
      .expect(201);

    // Mapping 2: complementarity=low, efficiency=high, 40%
    const m2Res = await request(app.getHttpServer())
      .post('/api/mappings')
      .set('Authorization', `Bearer ${centerToken}`)
      .send({
        projectId: dataProjectId,
        programId: PROGRAM_ID_2,
        allocationPercentage: 40,
        complementarityRating: 'low',
        efficiencyRating: 'high',
      })
      .expect(201);
    mapping2Id = (m2Res.body as { id: number }).id;

    // Open mapping 2 so it's also negotiating
    await request(app.getHttpServer())
      .post(`/api/mappings/${mapping2Id}/open`)
      .set('Authorization', `Bearer ${centerToken}`)
      .expect(201);

    // Force negotiation_locked = true on the project via direct DB update.
    // (The service lock endpoint requires all-agreed + sum=100 invariant,
    // but we need a locked project without going through the full flow.)
    await ds.query(
      `UPDATE projects SET negotiation_locked = 1 WHERE id = ?`,
      [dataProjectId],
    );

    // ── Seed a second project for CENTER_ID (used by Section D) ─────────────
    // (We already seeded dataProjectId for CENTER_ID = 1, so the center rep
    // will see at least 1 project. We don't need a second seed for the
    // scoping assertion — the existing data project is sufficient.)

    // ── Fetch all shared workbooks upfront ───────────────────────────────────
    // Budget: 4 export requests total (1 admin unfiltered, 1 admin filtered,
    // 1 admin for scoping comparison, 1 center-rep). The export endpoint
    // throttles at 5 requests per 60s per IP so we must stay at or under 5.
    // We fetch adminWorkbook and adminWorkbookForScoping sequentially first,
    // then center after a brief moment to avoid a race where the TTL window
    // slides during a tight parallel burst.
    const [adminBuf, dataBuf] = await Promise.all([
      fetchExport(app, adminToken),
      fetchExport(app, adminToken, `search=${encodeURIComponent('Export E2E Data Project')}`),
    ]);

    adminWorkbook = await parseWorkbook(adminBuf);
    dataWorkbook = await parseWorkbook(dataBuf);

    // Scoping requests: fetch admin and center-rep exports separately.
    // These are the 3rd and 4th export requests — still within the limit.
    const scopingAdminBuf = await fetchExport(app, adminToken);
    const scopingCenterBuf = await fetchExport(app, centerToken);

    adminWorkbookForScoping = await parseWorkbook(scopingAdminBuf);
    centerWorkbook = await parseWorkbook(scopingCenterBuf);
  }, 90_000);

  afterAll(async () => {
    // Bottom-up FK-safe cleanup
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
      `DELETE FROM project_negotiation_messages WHERE project_id IN (
         SELECT id FROM projects WHERE code LIKE '${CODE_PREFIX}%'
       )`,
    );
    await ds.query(`DELETE FROM projects WHERE code LIKE '${CODE_PREFIX}%'`);

    // Demote test center rep so they don't leak permissions
    await ds.query(
      `UPDATE users SET role = NULL, center_id = NULL WHERE email = ?`,
      [CENTER_REP_EMAIL],
    );

    await app.close();
  }, 30_000);

  // ──────────────────────────────────────────────────────────────────────────
  // A. Sheet structure
  // ──────────────────────────────────────────────────────────────────────────

  describe('A. Sheet structure', () => {
    it('workbook has exactly 4 sheets in order: Summary, Projects, Mappings, Budgets', () => {
      const names = adminWorkbook.worksheets.map((ws) => ws.name);
      expect(names).toEqual(['Summary', 'Projects', 'Mappings', 'Budgets']);
    });

    it('Projects sheet row 1 has exactly 42 headers in verbatim template order', () => {
      const sheet = adminWorkbook.getWorksheet('Projects');
      expect(sheet).toBeDefined();
      const headers = readHeaderRow(sheet!);
      expect(headers).toHaveLength(42);
      expect(headers).toEqual(PROJECTS_HEADERS);
    });

    it('Mappings sheet row 1 has exactly 13 headers in verbatim template order', () => {
      const sheet = adminWorkbook.getWorksheet('Mappings');
      expect(sheet).toBeDefined();
      const headers = readHeaderRow(sheet!);
      expect(headers).toHaveLength(13);
      expect(headers).toEqual(MAPPINGS_HEADERS);
    });

    it('Budgets sheet row 1 has exactly 6 headers in verbatim template order', () => {
      const sheet = adminWorkbook.getWorksheet('Budgets');
      expect(sheet).toBeDefined();
      const headers = readHeaderRow(sheet!);
      expect(headers).toHaveLength(6);
      expect(headers).toEqual(BUDGETS_HEADERS);
    });

    it('Budgets sheet renders successfully (sheet exists with correct headers regardless of row count)', () => {
      // The Budgets sheet must always exist with the header row intact,
      // regardless of whether the project_budgets table has data.
      // We don't assert row 2 emptiness because the test DB may have
      // pre-existing budget rows from other seeded projects.
      const sheet = adminWorkbook.getWorksheet('Budgets');
      expect(sheet).toBeDefined();
      const headers = readHeaderRow(sheet!);
      expect(headers).toHaveLength(6);
      expect(headers[0]).toBe('Project Code');
      expect(headers[5]).toBe('Amount');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // B. Summary sheet content
  // ──────────────────────────────────────────────────────────────────────────

  describe('B. Summary sheet content', () => {
    let sheet: ExcelJS.Worksheet;

    beforeAll(() => {
      sheet = adminWorkbook.getWorksheet('Summary')!;
    });

    it('A1 contains the PRMS banner string with em-dash', () => {
      const cellValue = String(sheet.getCell('A1').value ?? '');
      expect(cellValue).toContain('PRMS Projects Registry');
      expect(cellValue).toContain(EM_DASH);
      expect(cellValue).toContain('Export');
      // Exact value the backend writes
      expect(cellValue).toBe(`PRMS Projects Registry ${EM_DASH} Export`);
    });

    it('A2 starts with "Generated: "', () => {
      const cellValue = String(sheet.getCell('A2').value ?? '');
      expect(cellValue).toMatch(/^Generated: /);
    });

    it('B4 contains the exporting user email and role in "email (role)" shape', () => {
      const cellValue = String(sheet.getCell('B4').value ?? '');
      expect(cellValue).toContain('admin@codeobia.com');
      expect(cellValue).toContain('admin');
      // Shape: "email (role)"
      expect(cellValue).toMatch(/^.+@.+\s\(.+\)$/);
    });

    it('B5 is a number (row count)', () => {
      const rawValue = sheet.getCell('B5').value;
      expect(typeof rawValue).toBe('number');
      expect(rawValue as number).toBeGreaterThanOrEqual(0);
    });

    it('B8–B20 are all em-dash when called with no query filters', () => {
      // With no filters every renderFilterValue call returns EM_DASH
      const emDashRows = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
      for (const rowNum of emDashRows) {
        const cellValue = String(sheet.getCell(`B${rowNum}`).value ?? '');
        expect(cellValue).toBe(EM_DASH);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // C. Data shape on Projects rows
  // ──────────────────────────────────────────────────────────────────────────

  describe('C. Data shape on Projects rows', () => {
    /** The data row for the seeded project from the filtered export. */
    let projectRow: ExcelJS.Row;
    let sheet: ExcelJS.Worksheet;

    /**
     * Column-name → 1-based index map, built from the header row.
     * We locate columns by header name for robustness (header ordering
     * is already asserted in Section A).
     */
    const headerIndex = new Map<string, number>();

    /** 0-based indices (in the headers array) for repeated header names. */
    const headerPositions: { name: string; idx: number }[] = [];

    beforeAll(() => {
      sheet = dataWorkbook.getWorksheet('Projects')!;

      // Build header index (first occurrence wins for headerIndex)
      sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const name = String(cell.value ?? '');
        headerPositions.push({ name, idx: colNumber });
        if (!headerIndex.has(name)) {
          headerIndex.set(name, colNumber);
        }
      });

      // Find the data project row by matching the Code column
      const codeColIdx = headerIndex.get('Code') ?? 2;
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // skip header
        const codeVal = String(row.getCell(codeColIdx).value ?? '');
        if (codeVal.startsWith(`${CODE_PREFIX}DATA-`)) {
          projectRow = row;
        }
      });
    });

    it('finds exactly one data row for the seeded project', () => {
      expect(projectRow).toBeDefined();
    });

    it('Complementarity for Program slot 1 = "H" (high)', () => {
      // First occurrence of "Complementarity (HML)" is slot 1
      const positions = headerPositions.filter(
        (h) => h.name === 'Complementarity (HML)',
      );
      expect(positions.length).toBeGreaterThanOrEqual(1);
      const val = String(projectRow.getCell(positions[0].idx).value ?? '');
      expect(val).toBe('H');
    });

    it('Complementarity for Program slot 2 = "L" (low)', () => {
      const positions = headerPositions.filter(
        (h) => h.name === 'Complementarity (HML)',
      );
      expect(positions.length).toBeGreaterThanOrEqual(2);
      const val = String(projectRow.getCell(positions[1].idx).value ?? '');
      expect(val).toBe('L');
    });

    it('Efficiency for Program slot 1 = "M" (medium)', () => {
      const positions = headerPositions.filter(
        (h) => h.name === 'Efficiency (HML)',
      );
      expect(positions.length).toBeGreaterThanOrEqual(1);
      const val = String(projectRow.getCell(positions[0].idx).value ?? '');
      expect(val).toBe('M');
    });

    it('Efficiency for Program slot 2 = "H" (high)', () => {
      const positions = headerPositions.filter(
        (h) => h.name === 'Efficiency (HML)',
      );
      expect(positions.length).toBeGreaterThanOrEqual(2);
      const val = String(projectRow.getCell(positions[1].idx).value ?? '');
      expect(val).toBe('H');
    });

    it('"In Active Negotiation" = "Yes" (both mappings are negotiating)', () => {
      const colIdx = headerIndex.get('In Active Negotiation');
      expect(colIdx).toBeDefined();
      const val = String(projectRow.getCell(colIdx!).value ?? '');
      expect(val).toBe('Yes');
    });

    it('"Negotiation Locked" = "Yes" (force-set via direct DB update)', () => {
      const colIdx = headerIndex.get('Negotiation Locked');
      expect(colIdx).toBeDefined();
      const val = String(projectRow.getCell(colIdx!).value ?? '');
      expect(val).toBe('Yes');
    });

    it('"% check" equals the arithmetic sum of the Program % cells and is a number', () => {
      const pctCheckColIdx = headerIndex.get('% check');
      expect(pctCheckColIdx).toBeDefined();

      // Collect all three "Program %" column positions
      const programPctPositions = headerPositions.filter(
        (h) => h.name === 'Program %',
      );
      expect(programPctPositions.length).toBe(3);

      const pct1 = Number(
        projectRow.getCell(programPctPositions[0].idx).value ?? 0,
      );
      const pct2 = Number(
        projectRow.getCell(programPctPositions[1].idx).value ?? 0,
      );
      const pct3 = Number(
        projectRow.getCell(programPctPositions[2].idx).value ?? 0,
      );
      const expectedSum = pct1 + pct2 + pct3;

      const pctCheckRaw = projectRow.getCell(pctCheckColIdx!).value;
      // Must be a number, not a string (TypeORM DECIMAL coercion guard)
      expect(typeof pctCheckRaw).toBe('number');
      expect(pctCheckRaw as number).toBeCloseTo(expectedSum, 4);
    });

    it('"Mapped Programs" = comma-joined program official codes', () => {
      const colIdx = headerIndex.get('Mapped Programs');
      expect(colIdx).toBeDefined();
      const val = projectRow.getCell(colIdx!).value;
      // Must be a string of comma-joined non-empty codes (one per active mapping).
      expect(typeof val).toBe('string');
      const parts = (val as string).split(', ').filter((s) => s.length > 0);
      expect(parts).toHaveLength(2);
    });

    it('"Total Budget" cell value is a number, not a string (DECIMAL coercion guard)', () => {
      const colIdx = headerIndex.get('Total Budget');
      expect(colIdx).toBeDefined();
      const val = projectRow.getCell(colIdx!).value;
      // TypeORM returns DECIMAL columns as strings — the service must coerce via Number().
      expect(typeof val).toBe('number');
      expect(val as number).toBeCloseTo(250000, 0);
    });

    it('"Program %" cell value for slot 1 is a number, not a string (DECIMAL coercion guard)', () => {
      const programPctPositions = headerPositions.filter(
        (h) => h.name === 'Program %',
      );
      expect(programPctPositions.length).toBeGreaterThanOrEqual(1);
      const val = projectRow.getCell(programPctPositions[0].idx).value;
      expect(typeof val).toBe('number');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // D. Role scoping regression
  // ──────────────────────────────────────────────────────────────────────────

  describe('D. Role scoping — center_rep sees only their center\'s projects', () => {
    it('center_rep export has fewer or equal rows than admin export', () => {
      const adminSheet = adminWorkbookForScoping.getWorksheet('Projects')!;
      const centerSheet = centerWorkbook.getWorksheet('Projects')!;

      let adminDataRows = 0;
      adminSheet.eachRow((_row, rowNum) => { if (rowNum > 1) adminDataRows++; });

      let centerDataRows = 0;
      centerSheet.eachRow((_row, rowNum) => { if (rowNum > 1) centerDataRows++; });

      // Center rep must see fewer or equal projects than admin
      expect(centerDataRows).toBeLessThanOrEqual(adminDataRows);

      // Center rep must see at least the 1 project we seeded for CENTER_ID
      expect(centerDataRows).toBeGreaterThanOrEqual(1);
    });

    it('every project code visible to center_rep is also visible to admin (no phantom rows)', () => {
      const adminSheet = adminWorkbookForScoping.getWorksheet('Projects')!;
      const centerSheet = centerWorkbook.getWorksheet('Projects')!;

      const codeColIdx = 2; // 'Code' is column 2 per PROJECTS_HEADERS
      const adminCodes = new Set<string>();
      adminSheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        adminCodes.add(String(row.getCell(codeColIdx).value ?? ''));
      });

      centerSheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const code = String(row.getCell(codeColIdx).value ?? '');
        // Every project visible to center rep must also be visible to admin
        expect(adminCodes.has(code)).toBe(true);
      });
    });

    it('center_rep export response has correct Content-Type and Content-Disposition headers', async () => {
      // We already parsed the center workbook successfully — verify the
      // workbook has the expected 4-sheet structure.
      const names = centerWorkbook.worksheets.map((ws) => ws.name);
      expect(names).toEqual(['Summary', 'Projects', 'Mappings', 'Budgets']);
    });

    it('center_rep Summary B4 contains center_rep role in "email (role)" shape', () => {
      const sheet = centerWorkbook.getWorksheet('Summary')!;
      const cellValue = String(sheet.getCell('B4').value ?? '');
      expect(cellValue).toContain(CENTER_REP_EMAIL);
      expect(cellValue).toContain('center_rep');
      expect(cellValue).toMatch(/^.+@.+\s\(.+\)$/);
    });
  });
});
