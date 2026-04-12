/**
 * Integration tests for user admin endpoints:
 *   POST   /api/users
 *   DELETE /api/users/:id
 *
 * Uses the real MySQL database (docker-compose). All created rows use
 * the suffix "@qa-users-e2e.test" on the email so they are easy to
 * identify and are cleaned up in afterAll.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/modules/users/enums/user-role.enum';

/** Common suffix for all test emails — used for targeted cleanup. */
const EMAIL_SUFFIX = '@qa-users-e2e.test';

/** Seeded admin account from the dev database. */
const ADMIN_EMAIL = 'admin@codeobia.com';

/**
 * Issues a dev-token JWT for the given email so integration requests
 * can pass the global JwtAuthGuard without going through Cognito.
 *
 * The dev-token endpoint is only reachable when NODE_ENV=development,
 * which setup-env.ts forces before every test file.
 */
async function getToken(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .get(`/api/auth/dev-token?email=${encodeURIComponent(email)}`)
    .expect(200);

  return (res.body as { accessToken: string }).accessToken;
}

describe('Users admin — integration (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminToken: string;
  let adminUserId: number;

  /**
   * Id of the seeded program_rep used as a non-admin for 403 tests.
   * Created in beforeAll and cleaned up with the other test rows.
   */
  let programRepId: number;
  let programRepToken: string;
  const PROGRAM_REP_EMAIL = `program-rep${EMAIL_SUFFIX}`;

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
    adminToken = await getToken(app, ADMIN_EMAIL);

    const [adminRow]: Array<{ id: number }> = await dataSource.query(
      'SELECT id FROM users WHERE email = ?',
      [ADMIN_EMAIL],
    );
    adminUserId = adminRow.id;

    /* Create a non-admin user we can use to hit 403 paths. dev-token
     * creates the row with role=null, so we promote it to program_rep
     * via the admin PATCH endpoint (the DB layer, not direct SQL, so
     * we exercise the same code path real usage would). */
    programRepToken = await getToken(app, PROGRAM_REP_EMAIL);

    const [prRow]: Array<{ id: number }> = await dataSource.query(
      'SELECT id FROM users WHERE email = ?',
      [PROGRAM_REP_EMAIL],
    );
    programRepId = prRow.id;

    /* Promote to program_rep with a program association. Pick the
     * lowest-id program from the synced CLARISA data. */
    const [program]: Array<{ id: number }> = await dataSource.query(
      'SELECT id FROM programs ORDER BY id LIMIT 1',
    );

    await request(app.getHttpServer())
      .patch(`/api/users/${programRepId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: UserRole.PROGRAM_REP, programId: program.id })
      .expect(200);

    /* Re-issue the token so its payload reflects the new role. */
    programRepToken = await getToken(app, PROGRAM_REP_EMAIL);
  });

  afterAll(async () => {
    /* Remove all e2e test users by email suffix so repeated runs stay
     * idempotent. Order matters if any mapping/project references these
     * rows, but none do — they were never used outside this file. */
    await dataSource.query(`DELETE FROM users WHERE email LIKE ?`, [
      `%${EMAIL_SUFFIX}`,
    ]);
    await app.close();
  });

  /* ------------------------------------------------------------------ */
  /* POST /api/users                                                     */
  /* ------------------------------------------------------------------ */

  describe('POST /api/users', () => {
    it('as admin — creates a user with cognito_sub NULL and returns 201', async () => {
      const payload = {
        email: `created-by-admin${EMAIL_SUFFIX}`,
        firstName: 'Created',
        lastName: 'ByAdmin',
      };

      const res = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload)
        .expect(201);

      const body = res.body as {
        id: number;
        email: string;
        firstName: string;
        lastName: string;
        isActive: boolean;
      };
      expect(body.email).toBe(payload.email);
      expect(body.firstName).toBe('Created');
      expect(body.lastName).toBe('ByAdmin');
      expect(body.isActive).toBe(true);

      /* Ground-truth DB check: cognito_sub must be NULL and the row
       * must actually exist. */
      const [row]: Array<{
        id: number;
        cognito_sub: string | null;
        is_active: number;
      }> = await dataSource.query(
        'SELECT id, cognito_sub, is_active FROM users WHERE email = ?',
        [payload.email],
      );
      expect(row).toBeDefined();
      expect(row.cognito_sub).toBeNull();
      expect(row.is_active).toBe(1);
    });

    it('as non-admin (program_rep) — returns 403', async () => {
      await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${programRepToken}`)
        .send({
          email: `rejected${EMAIL_SUFFIX}`,
          firstName: 'Rejected',
          lastName: 'User',
        })
        .expect(403);

      /* Guard must kick in before any insert happens. */
      const rows: Array<{ id: number }> = await dataSource.query(
        'SELECT id FROM users WHERE email = ?',
        [`rejected${EMAIL_SUFFIX}`],
      );
      expect(rows).toHaveLength(0);
    });

    it('with duplicate email — returns 409', async () => {
      const email = `duplicate${EMAIL_SUFFIX}`;

      /* First create — succeeds. */
      await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email, firstName: 'Dup', lastName: 'One' })
        .expect(201);

      /* Second create — conflicts. */
      await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email, firstName: 'Dup', lastName: 'Two' })
        .expect(409);
    });
  });

  /* ------------------------------------------------------------------ */
  /* DELETE /api/users/:id                                               */
  /* ------------------------------------------------------------------ */

  describe('DELETE /api/users/:id', () => {
    let victimId: number;

    /* Fresh target user for each test to keep assertions independent
     * even if one of the earlier tests mutated the row. */
    beforeEach(async () => {
      const email = `victim-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 7)}${EMAIL_SUFFIX}`;
      const res = await request(app.getHttpServer())
        .post('/api/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email, firstName: 'Victim', lastName: 'User' })
        .expect(201);
      victimId = (res.body as { id: number }).id;
    });

    it('as admin on another user — returns 200 and flips is_active to 0', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/users/${victimId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body).toEqual({ id: victimId, isActive: false });

      const [row]: Array<{ is_active: number }> = await dataSource.query(
        'SELECT is_active FROM users WHERE id = ?',
        [victimId],
      );
      expect(row.is_active).toBe(0);
    });

    it('as admin on self — returns 403 and leaves is_active unchanged', async () => {
      await request(app.getHttpServer())
        .delete(`/api/users/${adminUserId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);

      const [row]: Array<{ is_active: number }> = await dataSource.query(
        'SELECT is_active FROM users WHERE id = ?',
        [adminUserId],
      );
      expect(row.is_active).toBe(1);
    });

    it('as non-admin (program_rep) — returns 403', async () => {
      await request(app.getHttpServer())
        .delete(`/api/users/${victimId}`)
        .set('Authorization', `Bearer ${programRepToken}`)
        .expect(403);

      /* Victim must still be active — the guard must have blocked
       * the call before the service ran. */
      const [row]: Array<{ is_active: number }> = await dataSource.query(
        'SELECT is_active FROM users WHERE id = ?',
        [victimId],
      );
      expect(row.is_active).toBe(1);
    });
  });
});
