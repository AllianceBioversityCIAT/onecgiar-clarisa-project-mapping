/**
 * Integration tests for POST /api/projects and PATCH /api/projects/:id.
 *
 * Uses the real MySQL database (docker-compose) — no mocked repositories.
 * All test rows use the prefix "QA-INT-" on the project code so they are
 * easy to identify and are cleaned up in afterAll.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { NatureOfFunder } from '../src/modules/projects/enums/nature-of-funder.enum';
import { ProjectCategory } from '../src/modules/projects/enums/project-category.enum';
import { CspFlag } from '../src/modules/projects/enums/csp-flag.enum';

/** The center and admin user IDs that exist in the seeded DB. */
const SEED_CENTER_ID = 1;
const ADMIN_USER_ID = 1;

/** Prefix for all test project codes — used for targeted cleanup. */
const CODE_PREFIX = 'QA-INT-';

/**
 * Issues a dev-token JWT for the given user id so integration requests
 * can pass the global JwtAuthGuard.
 *
 * The dev-token endpoint is only available when NODE_ENV=development,
 * which is the docker-compose default.
 */
async function getAdminToken(app: INestApplication): Promise<string> {
  const res = await request(app.getHttpServer())
    .get('/api/auth/dev-token?email=admin@codeobia.com')
    .expect(200);

  return (res.body as { accessToken: string }).accessToken;
}

describe('Projects — integration (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    /* Mirror bootstrap exactly so guards, pipes, and prefix match prod. */
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

    dataSource = app.get(DataSource);
    adminToken = await getAdminToken(app);
  });

  afterAll(async () => {
    /* Delete all test rows by code prefix — cascade removes budgets. */
    await dataSource.query(
      `DELETE FROM projects WHERE code LIKE '${CODE_PREFIX}%'`,
    );
    await app.close();
  });

  /* ------------------------------------------------------------------ */
  /* POST /api/projects — full payload with all new fields + budgets     */
  /* ------------------------------------------------------------------ */

  describe('POST /api/projects', () => {
    it('creates a project with all 8 optional fields and 3 budget lines — returns 201 and persists', async () => {
      const payload = {
        code: `${CODE_PREFIX}FULL-001`,
        name: 'Full Payload Project',
        totalBudget: 500000,
        centerId: SEED_CENTER_ID,
        funderPrimaryCenter: 'BMGF',
        natureOfFunder: NatureOfFunder.FOUNDATION,
        category: ProjectCategory.RESTRICTED,
        csp: CspFlag.NO,
        cspNonCollectionReason: 'Not applicable',
        totalPledge: 600000,
        principalInvestigator: 'DOE, JANE',
        signedContractTitle: 'Grant Agreement 2026-E2E',
        budgets: [
          {
            year: 'FY25',
            version: 'FPC-I',
            account: 'Staff Costs',
            amount: 200000,
          },
          { year: 'FY25', version: 'FPC-I', account: 'Travel', amount: 50000 },
          {
            year: 'FY26',
            version: 'FPC-II',
            account: 'Staff Costs',
            amount: 250000,
          },
        ],
      };

      /* Create */
      const createRes = await request(app.getHttpServer())
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload)
        .expect(201);

      const created = createRes.body as {
        id: number;
        code: string;
        funderPrimaryCenter: string;
        natureOfFunder: string;
        category: string;
        csp: string;
        cspNonCollectionReason: string;
        totalPledge: string;
        principalInvestigator: string;
        signedContractTitle: string;
        budgets: Array<{ year: string; account: string; amount: string }>;
      };

      expect(created.code).toBe(payload.code);
      expect(created.funderPrimaryCenter).toBe('BMGF');
      expect(created.natureOfFunder).toBe(NatureOfFunder.FOUNDATION);
      expect(created.category).toBe(ProjectCategory.RESTRICTED);
      expect(created.csp).toBe(CspFlag.NO);
      expect(created.cspNonCollectionReason).toBe('Not applicable');
      /* MySQL decimal columns come back as strings from TypeORM */
      expect(Number(created.totalPledge)).toBe(600000);
      expect(created.principalInvestigator).toBe('DOE, JANE');
      expect(created.signedContractTitle).toBe('Grant Agreement 2026-E2E');
      expect(created.budgets).toHaveLength(3);

      /* Subsequent GET must return identical data */
      const getRes = await request(app.getHttpServer())
        .get(`/api/projects/${created.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const fetched = getRes.body as typeof created;
      expect(fetched.funderPrimaryCenter).toBe('BMGF');
      expect(fetched.natureOfFunder).toBe(NatureOfFunder.FOUNDATION);
      expect(fetched.budgets).toHaveLength(3);

      /* Budgets must be ordered year ASC then account ASC */
      const budgetAccounts = fetched.budgets.map((b) => b.account);
      expect(budgetAccounts[0]).toBe(
        'Staff Costs',
      ); /* FY25 Staff < FY25 Travel */
      expect(budgetAccounts[1]).toBe('Travel');
      expect(budgetAccounts[2]).toBe('Staff Costs'); /* FY26 Staff */
    });

    it('rejects with 400 when natureOfFunder is an invalid enum value', async () => {
      await request(app.getHttpServer())
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: `${CODE_PREFIX}INVALID-ENUM`,
          name: 'Bad Enum',
          totalBudget: 0,
          centerId: SEED_CENTER_ID,
          natureOfFunder: 'NotARealFunder',
        })
        .expect(400);
    });
  });

  /* ------------------------------------------------------------------ */
  /* PATCH /api/projects/:id — partial scalar update (csp fields only)  */
  /* ------------------------------------------------------------------ */

  describe('PATCH /api/projects/:id — partial scalar update', () => {
    let projectId: number;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: `${CODE_PREFIX}PATCH-CSP`,
          name: 'CSP Patch Target',
          totalBudget: 100000,
          centerId: SEED_CENTER_ID,
          csp: CspFlag.YES,
        })
        .expect(201);

      projectId = (res.body as { id: number }).id;
    });

    it('updates only csp and cspNonCollectionReason without touching other fields', async () => {
      const patchRes = await request(app.getHttpServer())
        .patch(`/api/projects/${projectId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          csp: CspFlag.NO,
          cspNonCollectionReason: 'Budget ceiling reached',
        })
        .expect(200);

      const updated = patchRes.body as {
        csp: string;
        cspNonCollectionReason: string;
        name: string;
        totalBudget: string;
      };
      expect(updated.csp).toBe(CspFlag.NO);
      expect(updated.cspNonCollectionReason).toBe('Budget ceiling reached');
      /* Other fields must be unchanged */
      expect(updated.name).toBe('CSP Patch Target');
      expect(Number(updated.totalBudget)).toBe(100000);
    });
  });

  /* ------------------------------------------------------------------ */
  /* PATCH /api/projects/:id — budget diff (update + insert + delete)   */
  /* ------------------------------------------------------------------ */

  describe('PATCH /api/projects/:id — budget diff', () => {
    let projectId: number;
    let budgetIds: number[];

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .post('/api/projects')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: `${CODE_PREFIX}BUDGET-DIFF`,
          name: 'Budget Diff Target',
          totalBudget: 200000,
          centerId: SEED_CENTER_ID,
          budgets: [
            { year: 'FY25', version: 'v1', account: 'Staff', amount: 80000 },
            { year: 'FY25', version: 'v1', account: 'Travel', amount: 20000 },
            {
              year: 'FY25',
              version: 'v1',
              account: 'Equipment',
              amount: 15000,
            },
          ],
        })
        .expect(201);

      const body = res.body as {
        id: number;
        budgets: Array<{ id: number; account: string }>;
      };
      projectId = body.id;
      budgetIds = body.budgets.map((b) => b.id);
    });

    it('applies one update, one insert, one delete and persists the correct DB state', async () => {
      /* budgetIds[0] → update Staff amount
       * budgetIds[1] → delete Travel (omit from payload)
       * Equipment (budgetIds[2]) → keep unchanged
       * new row → insert Consultants */
      const patchPayload = {
        budgets: [
          {
            id: budgetIds[0],
            year: 'FY25',
            version: 'v1',
            account: 'Staff',
            amount: 90000,
          }, // update
          {
            id: budgetIds[2],
            year: 'FY25',
            version: 'v1',
            account: 'Equipment',
            amount: 15000,
          }, // keep
          {
            year: 'FY26',
            version: 'v2',
            account: 'Consultants',
            amount: 30000,
          }, // insert
          // Travel (budgetIds[1]) deliberately omitted → should be deleted
        ],
      };

      await request(app.getHttpServer())
        .patch(`/api/projects/${projectId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(patchPayload)
        .expect(200);

      /* Verify via direct DB query for ground-truth assertion */
      const rows: Array<{ id: number; account: string; amount: string }> =
        await dataSource.query(
          'SELECT id, account, amount FROM project_budgets WHERE project_id = ? ORDER BY account ASC',
          [projectId],
        );

      expect(rows).toHaveLength(3); /* Staff, Equipment, Consultants */

      const byAccount = Object.fromEntries(rows.map((r) => [r.account, r]));

      expect(Number(byAccount['Staff'].amount)).toBe(90000); // updated
      expect(Number(byAccount['Equipment'].amount)).toBe(15000); // unchanged
      expect(Number(byAccount['Consultants'].amount)).toBe(30000); // inserted
      expect(byAccount['Travel']).toBeUndefined(); // deleted
    });
  });
});
