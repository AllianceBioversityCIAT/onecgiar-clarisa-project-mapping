/**
 * Integration tests for the Settings endpoints:
 *   GET   /api/settings  — any authenticated user
 *   PATCH /api/settings  — admin only
 *
 * Uses the real MySQL database (docker-compose). The singleton
 * `system_settings` row (id=1) is mutated by PATCH tests; `afterAll`
 * resets it to defaults so the suite leaves the DB clean.
 *
 * Actor accounts are created via the dev-token endpoint (NODE_ENV=development
 * forced by setup-env.ts) and promoted to the required role via direct SQL,
 * exactly as the other e2e suites do.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/modules/users/enums/user-role.enum';

// ── Actor e-mail addresses ────────────────────────────────────────────────────
const ADMIN_EMAIL = 'admin@codeobia.com';
const CENTER_REP_EMAIL = 'settings-e2e-center@codeobia.com';
const PROGRAM_REP_EMAIL = 'settings-e2e-program@codeobia.com';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Issues a dev-token JWT for the given email. The dev-token endpoint is only
 * reachable when NODE_ENV=development, which setup-env.ts forces before every
 * test file.
 */
async function getToken(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .get(`/api/auth/dev-token?email=${encodeURIComponent(email)}`)
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

/**
 * Promotes a dev-created user to the requested role. dev-login creates users
 * with role=null; the settings PATCH endpoint needs an admin actor.
 */
async function ensureRole(
  ds: DataSource,
  email: string,
  role: UserRole,
  centerId: number | null,
  programId: number | null,
): Promise<number> {
  await ds.query(
    `UPDATE users
        SET role = ?, center_id = ?, program_id = ?, is_active = 1
      WHERE email = ?`,
    [role, centerId, programId, email],
  );
  const rows = await ds.query<{ id: number }[]>(
    `SELECT id FROM users WHERE email = ?`,
    [email],
  );
  return rows[0].id;
}

/**
 * Returns today's date as a `YYYY-MM-DD` string using local date parts.
 * Mirrors the service's `getTodayLocalIsoDate()` so the e2e boundary tests
 * stay in sync with the validation logic without hardcoding dates.
 */
function todayLocalIso(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns a past date as a `YYYY-MM-DD` string (daysBack days ago).
 */
function pastIso(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Settings — integration (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let adminToken: string;
  let adminUserId: number;
  let centerRepToken: string;
  let programRepToken: string;

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    /* Mirror main.ts bootstrap exactly so guards, pipes, and prefix match prod */
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

    /* Issue tokens for all actors. dev-token creates the user row if missing. */
    adminToken = await getToken(app, ADMIN_EMAIL);
    centerRepToken = await getToken(app, CENTER_REP_EMAIL);
    programRepToken = await getToken(app, PROGRAM_REP_EMAIL);

    /* Promote non-admin actors to their roles. */
    await ensureRole(ds, CENTER_REP_EMAIL, UserRole.CENTER_REP, 1, null);
    await ensureRole(ds, PROGRAM_REP_EMAIL, UserRole.PROGRAM_REP, null, 1);

    /* Re-issue after role promotion so the JWT payload reflects the role. */
    centerRepToken = await getToken(app, CENTER_REP_EMAIL);
    programRepToken = await getToken(app, PROGRAM_REP_EMAIL);

    /* Capture admin user id for updatedBy assertion in case 4. */
    const [adminRow] = await ds.query<{ id: number }[]>(
      `SELECT id FROM users WHERE email = ?`,
      [ADMIN_EMAIL],
    );
    adminUserId = adminRow.id;
  });

  afterAll(async () => {
    /* Reset the singleton row to clean defaults so later test runs start fresh. */
    await ds.query(
      `UPDATE system_settings
          SET email_enabled = 0, deadline_enabled = 0,
              deadline_date = NULL, updated_by = NULL
        WHERE id = 1`,
    );

    /* Strip roles from the test-only actors so they don't pollute the dev DB. */
    await ds.query(
      `UPDATE users
          SET role = NULL, center_id = NULL, program_id = NULL
        WHERE email IN (?, ?)`,
      [CENTER_REP_EMAIL, PROGRAM_REP_EMAIL],
    );

    await app.close();
  });

  // ── GET /api/settings ──────────────────────────────────────────────────────

  describe('GET /api/settings', () => {
    it('case 1 — admin JWT → 200 with correct response shape', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const body = res.body as Record<string, unknown>;

      // Required keys must be present.
      expect(body).toHaveProperty('emailEnabled');
      expect(body).toHaveProperty('deadlineEnabled');
      expect(body).toHaveProperty('deadlineDate');
      expect(body).toHaveProperty('updatedAt');
      expect(body).toHaveProperty('updatedBy');

      // The singleton `id` must NOT appear in the response.
      expect(body).not.toHaveProperty('id');
    });

    it('case 2 — center_rep JWT → 200 (any-auth endpoint)', async () => {
      await request(app.getHttpServer())
        .get('/api/settings')
        .set('Authorization', `Bearer ${centerRepToken}`)
        .expect(200);
    });

    it('case 3 — no JWT → 401', async () => {
      await request(app.getHttpServer()).get('/api/settings').expect(401);
    });
  });

  // ── PATCH /api/settings ────────────────────────────────────────────────────

  describe('PATCH /api/settings', () => {
    it('case 4 — admin, emailEnabled=true deadlineEnabled=false → 200, deadlineDate=null, updatedBy=adminUserId', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ emailEnabled: true, deadlineEnabled: false })
        .expect(200);

      const body = res.body as {
        emailEnabled: boolean;
        deadlineEnabled: boolean;
        deadlineDate: string | null;
        updatedBy: number | null;
      };

      expect(body.emailEnabled).toBe(true);
      expect(body.deadlineEnabled).toBe(false);
      expect(body.deadlineDate).toBeNull();
      // updatedBy is the admin's user id, not their email.
      expect(body.updatedBy).toBe(adminUserId);
    });

    it('case 5 — admin, deadlineEnabled=true with future date → 200, persisted correctly', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          emailEnabled: false,
          deadlineEnabled: true,
          deadlineDate: '2099-12-31',
        })
        .expect(200);

      const body = res.body as {
        emailEnabled: boolean;
        deadlineEnabled: boolean;
        deadlineDate: string | null;
      };

      expect(body.emailEnabled).toBe(false);
      expect(body.deadlineEnabled).toBe(true);
      expect(body.deadlineDate).toBe('2099-12-31');
    });

    it('case 6 — deadlineEnabled=true without deadlineDate → 400', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ emailEnabled: false, deadlineEnabled: true })
        .expect(400);

      const message = JSON.stringify(res.body.message ?? '');
      expect(message).toMatch(/deadlineDate/i);
    });

    it('case 7 — deadlineEnabled=true with a past date → 400 (future date required)', async () => {
      const pastDate = pastIso(7); // 7 days ago — robust even during DST

      const res = await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          emailEnabled: false,
          deadlineEnabled: true,
          deadlineDate: pastDate,
        })
        .expect(400);

      const message = JSON.stringify(res.body.message ?? '');
      expect(message).toMatch(/future/i);
    });

    it("case 8 — deadlineEnabled=true with today's date → 400 (today is not strictly future)", async () => {
      const today = todayLocalIso();

      const res = await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          emailEnabled: false,
          deadlineEnabled: true,
          deadlineDate: today,
        })
        .expect(400);

      const message = JSON.stringify(res.body.message ?? '');
      expect(message).toMatch(/future/i);
    });

    it('case 9 — deadlineEnabled=false with a future date → 200, deadlineDate coerced to null', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          emailEnabled: false,
          deadlineEnabled: false,
          deadlineDate: '2099-12-31',
        })
        .expect(200);

      const body = res.body as { deadlineDate: string | null };
      // The service must coerce to null even though a date was supplied.
      expect(body.deadlineDate).toBeNull();
    });

    it('case 10 — program_rep JWT → 403', async () => {
      await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Authorization', `Bearer ${programRepToken}`)
        .send({ emailEnabled: false, deadlineEnabled: false })
        .expect(403);
    });

    it('case 11 — center_rep JWT → 403', async () => {
      await request(app.getHttpServer())
        .patch('/api/settings')
        .set('Authorization', `Bearer ${centerRepToken}`)
        .send({ emailEnabled: false, deadlineEnabled: false })
        .expect(403);
    });

    it('case 12 — no JWT → 401', async () => {
      await request(app.getHttpServer())
        .patch('/api/settings')
        .send({ emailEnabled: false, deadlineEnabled: false })
        .expect(401);
    });
  });
});
