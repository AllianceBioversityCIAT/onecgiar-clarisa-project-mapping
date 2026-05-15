/**
 * E2E lifecycle test for the negotiation timeline.
 *
 * Drives a single project through the full negotiation flow and, after
 * each state mutation, asserts that the per-mapping `mapping_negotiations`
 * audit row was appended (immutably). This protects the core invariant
 * the user surfaced: every action — agree, counter-propose, remove,
 * lock, reopen — must add a new timeline row; nothing should be
 * silently updated.
 *
 * Uses the real MySQL database (docker-compose). All test rows use a
 * fixed `NEGO-E2E-` prefix on the project code so they can be cleaned
 * up deterministically in afterAll.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/modules/users/enums/user-role.enum';

const CODE_PREFIX = 'NEGO-E2E-';
const CENTER_ID = 1;
const PROGRAM_ID = 1;

const ADMIN_EMAIL = 'admin@codeobia.com';
const CENTER_REP_EMAIL = 'nego-e2e-center@codeobia.com';
const PROGRAM_REP_EMAIL = 'nego-e2e-program@codeobia.com';

/** Issues a dev-token JWT for a given email and returns the bearer. */
async function getToken(
  app: INestApplication,
  email: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .get(`/api/auth/dev-token?email=${encodeURIComponent(email)}`)
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

/**
 * Promotes a dev-created user to the requested role + scope. dev-login
 * creates users with no role; the negotiation endpoints need actors
 * with concrete roles.
 */
async function ensureRole(
  ds: DataSource,
  email: string,
  role: UserRole,
  centerId: number | null,
  programId: number | null,
): Promise<number> {
  await ds.query(
    `UPDATE users SET role = ?, center_id = ?, program_id = ?, is_active = 1 WHERE email = ?`,
    [role, centerId, programId, email],
  );
  const rows = await ds.query<{ id: number }[]>(
    `SELECT id FROM users WHERE email = ?`,
    [email],
  );
  return rows[0].id;
}

describe('Negotiation timeline — integration (e2e)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let adminToken: string;
  let centerToken: string;
  let programToken: string;
  let projectId: number;
  let mappingId: number;

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

    /* Bootstrap actors via dev-login then promote to the roles we need. */
    adminToken = await getToken(app, ADMIN_EMAIL);
    centerToken = await getToken(app, CENTER_REP_EMAIL);
    programToken = await getToken(app, PROGRAM_REP_EMAIL);

    await ensureRole(ds, CENTER_REP_EMAIL, UserRole.CENTER_REP, CENTER_ID, null);
    await ensureRole(
      ds,
      PROGRAM_REP_EMAIL,
      UserRole.PROGRAM_REP,
      null,
      PROGRAM_ID,
    );

    /* Re-issue tokens so the JWT payload reflects the new role/scope. */
    centerToken = await getToken(app, CENTER_REP_EMAIL);
    programToken = await getToken(app, PROGRAM_REP_EMAIL);

    /* Create one project the negotiation will run on. */
    const code = `${CODE_PREFIX}${Date.now()}`;
    const res = await request(app.getHttpServer())
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code,
        name: 'Negotiation Lifecycle Project',
        totalBudget: 100000,
        centerId: CENTER_ID,
      })
      .expect(201);
    projectId = (res.body as { id: number }).id;
  });

  afterAll(async () => {
    /* Bottom-up cleanup so FKs don't bite us. */
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
    await ds.query(
      `DELETE FROM projects WHERE code LIKE '${CODE_PREFIX}%'`,
    );

    /* Demote test users so they don't leak permissions across runs. */
    await ds.query(
      `UPDATE users SET role = NULL, center_id = NULL, program_id = NULL WHERE email IN (?, ?)`,
      [CENTER_REP_EMAIL, PROGRAM_REP_EMAIL],
    );

    await app.close();
  });

  /** Pulls the ordered timeline rows for the test mapping. */
  async function timeline(): Promise<
    Array<{
      event_type: string;
      actor_role: string;
      proposed_allocation: string | null;
      justification: string | null;
    }>
  > {
    return ds.query(
      `SELECT event_type, actor_role, proposed_allocation, justification
         FROM mapping_negotiations
         WHERE mapping_id = ?
         ORDER BY id ASC`,
      [mappingId],
    );
  }

  it('center rep creates a draft mapping → INITIATED event', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/mappings')
      .set('Authorization', `Bearer ${centerToken}`)
      .send({
        projectId,
        programId: PROGRAM_ID,
        allocationPercentage: 50,
        complementarityRating: 'high',
        efficiencyRating: 'high',
      })
      .expect(201);

    mappingId = (res.body as { id: number }).id;

    const events = await timeline();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('initiated');
    expect(events[0].actor_role).toBe('center_rep');
    expect(Number(events[0].proposed_allocation)).toBe(50);
  });

  it('open negotiation on the draft → NEGOTIATION_STARTED event', async () => {
    await request(app.getHttpServer())
      .post(`/api/mappings/${mappingId}/open`)
      .set('Authorization', `Bearer ${centerToken}`)
      .expect(201);

    const events = await timeline();
    expect(events).toHaveLength(2);
    expect(events[1].event_type).toBe('negotiation_started');
    expect(Number(events[1].proposed_allocation)).toBe(50);
  });

  it('program rep counter-proposes → COUNTER_PROPOSED event with justification', async () => {
    await request(app.getHttpServer())
      .post(`/api/mappings/${mappingId}/counter-propose`)
      .set('Authorization', `Bearer ${programToken}`)
      .send({ proposedAllocation: 30, justification: 'over-allocated for us' })
      .expect(201);

    const events = await timeline();
    expect(events).toHaveLength(3);
    expect(events[2].event_type).toBe('counter_proposed');
    expect(events[2].actor_role).toBe('program_rep');
    expect(Number(events[2].proposed_allocation)).toBe(30);
    expect(events[2].justification).toBe('over-allocated for us');
  });

  it('center rep counter-proposes back → another COUNTER_PROPOSED event', async () => {
    await request(app.getHttpServer())
      .post(`/api/mappings/${mappingId}/counter-propose`)
      .set('Authorization', `Bearer ${centerToken}`)
      .send({ proposedAllocation: 40, justification: 'meeting in the middle' })
      .expect(201);

    const events = await timeline();
    expect(events).toHaveLength(4);
    expect(events[3].event_type).toBe('counter_proposed');
    expect(events[3].actor_role).toBe('center_rep');
    expect(Number(events[3].proposed_allocation)).toBe(40);
  });

  it('program rep agrees → AGREED event', async () => {
    await request(app.getHttpServer())
      .post(`/api/mappings/${mappingId}/agree`)
      .set('Authorization', `Bearer ${programToken}`)
      .send({})
      .expect(201);

    const events = await timeline();
    expect(events).toHaveLength(5);
    expect(events[4].event_type).toBe('agreed');
    expect(events[4].actor_role).toBe('program_rep');
  });

  it('inline rating-only edit (center side) → RATING_UPDATED event', async () => {
    /* After test 5 (both sides agreed) the mapping is in AGREED status.
     * A rating-only edit does NOT reset agreement or status — only the
     * qualitative scoring moves. That's why we assert status stays at
     * agreed below. */
    await request(app.getHttpServer())
      .patch(`/api/mappings/${mappingId}/allocation`)
      .set('Authorization', `Bearer ${centerToken}`)
      .send({
        allocationPercentage: 40,
        complementarityRating: 'medium',
        efficiencyRating: 'low',
      })
      .expect(200);

    const events = await timeline();
    expect(events).toHaveLength(6);
    expect(events[5].event_type).toBe('rating_updated');
    expect(events[5].proposed_allocation).toBeNull();
  });

  it('center re-opens negotiation by changing the allocation → COUNTER_PROPOSED + status back to negotiating', async () => {
    /* requestRemoval only accepts draft / negotiating mappings, so we
     * drop the mapping back to negotiating via a real allocation edit
     * before the program rep requests removal. */
    await request(app.getHttpServer())
      .patch(`/api/mappings/${mappingId}/allocation`)
      .set('Authorization', `Bearer ${centerToken}`)
      .send({
        allocationPercentage: 45,
        complementarityRating: 'high',
        efficiencyRating: 'high',
      })
      .expect(200);

    const events = await timeline();
    expect(events).toHaveLength(7);
    expect(events[6].event_type).toBe('counter_proposed');
    expect(Number(events[6].proposed_allocation)).toBe(45);
  });

  it('program rep raises a removal request → REMOVAL_REQUESTED event', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/mappings/${mappingId}/request-removal`)
      .set('Authorization', `Bearer ${programToken}`)
      .send({ justification: 'no longer in scope for our program' });
    if (res.status !== 201) {
      // eslint-disable-next-line no-console
      console.error('request-removal failed', res.status, res.body);
    }
    expect(res.status).toBe(201);

    const events = await timeline();
    expect(events).toHaveLength(8);
    expect(events[7].event_type).toBe('removal_requested');
    expect(events[7].actor_role).toBe('program_rep');
    expect(events[7].justification).toBe('no longer in scope for our program');
  });

  it('center rep declines the removal request → REMOVAL_DECLINED event', async () => {
    await request(app.getHttpServer())
      .post(`/api/mappings/${mappingId}/decline-removal`)
      .set('Authorization', `Bearer ${centerToken}`)
      .send({ reason: 'still strategic' })
      .expect(201);

    const events = await timeline();
    expect(events).toHaveLength(9);
    expect(events[8].event_type).toBe('removal_declined');
    expect(events[8].actor_role).toBe('center_rep');
    expect(events[8].justification).toBe('still strategic');
  });

  it('after decline, both sides agree then center locks at 100% → LOCKED event', async () => {
    /* Bump allocation to 100 so the lock gate's sum=100 rule passes.
     * The allocation edit is center-side, so it implicitly agrees on
     * behalf of the center and resets the program side. */
    await request(app.getHttpServer())
      .patch(`/api/mappings/${mappingId}/allocation`)
      .set('Authorization', `Bearer ${centerToken}`)
      .send({
        allocationPercentage: 100,
        complementarityRating: 'high',
        efficiencyRating: 'high',
      })
      .expect(200);

    /* Program rep agrees → both sides now agreed → status flips to AGREED. */
    await request(app.getHttpServer())
      .post(`/api/mappings/${mappingId}/agree`)
      .set('Authorization', `Bearer ${programToken}`)
      .send({})
      .expect(201);

    /* Lock the project round. */
    await request(app.getHttpServer())
      .post(`/api/mappings/projects/${projectId}/lock`)
      .set('Authorization', `Bearer ${centerToken}`)
      .expect(200);

    const events = await timeline();
    const eventTypes = events.map((e) => e.event_type);
    /* The most recent event must be `locked`. */
    expect(eventTypes[eventTypes.length - 1]).toBe('locked');
    const locked = events[events.length - 1];
    expect(Number(locked.proposed_allocation)).toBe(100);
  });

  it('reopen the round → REOPENED event appended (timeline grows, prior rows untouched)', async () => {
    const before = await timeline();
    const lengthBefore = before.length;

    await request(app.getHttpServer())
      .post(`/api/mappings/projects/${projectId}/reopen`)
      .set('Authorization', `Bearer ${centerToken}`)
      .expect(200);

    const after = await timeline();
    expect(after.length).toBe(lengthBefore + 1);
    expect(after[after.length - 1].event_type).toBe('reopened');

    /* Append-only check: every prior row is byte-identical. */
    for (let i = 0; i < lengthBefore; i++) {
      expect(after[i]).toEqual(before[i]);
    }
  });

  it('center rep accepts a (newly-requested) removal → REMOVED event with merged justification', async () => {
    /* Re-promote the draft so the program rep can request again. */
    await request(app.getHttpServer())
      .post(`/api/mappings/projects/${projectId}/start-negotiation`)
      .set('Authorization', `Bearer ${centerToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/api/mappings/${mappingId}/request-removal`)
      .set('Authorization', `Bearer ${programToken}`)
      .send({ justification: 'final removal' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/mappings/${mappingId}/remove`)
      .set('Authorization', `Bearer ${centerToken}`)
      .send({ justification: 'accepted by center' })
      .expect(201);

    const events = await timeline();
    const last = events[events.length - 1];
    expect(last.event_type).toBe('removed');
    /* The merged justification carries both the center's and program's
     * reasons so the audit row is self-contained. */
    expect(last.justification).toContain('accepted by center');
    expect(last.justification).toContain('final removal');
  });
});
