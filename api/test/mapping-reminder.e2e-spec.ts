/**
 * E2E integration tests for MappingReminderService.runTick()
 *
 * Verifies the full DB-integrated behavior of the cron worker that
 * enqueues center-mapping reminder emails: cadence gating (weekly
 * Monday vs daily within 3-day window), per-center progress thresholds,
 * idempotency, email row shape, and the 90%-center skip.
 *
 * Uses the real MySQL database (docker-compose). All test rows use a
 * fixed `REMIND-E2E-` prefix on project codes for deterministic cleanup.
 * The test calls `runTick(fakeNow)` directly — the @Cron scheduler is
 * never triggered.
 *
 * Center selection: CIFOR (id=4) and CIMMYT (id=5) were chosen because
 * they have zero real projects and zero existing center_rep users, giving
 * the suite full isolation — no pre-existing rows can pollute counts.
 *
 * Run:
 *   cd api && npx jest --config test/jest-e2e.json test/mapping-reminder.e2e-spec.ts
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MappingReminderService } from '../src/modules/emails/mapping-reminder.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_PREFIX = 'REMIND-E2E-';
const TEMPLATE_KEY = 'center_mapping_reminder';

/**
 * Center A = CIFOR (id=4): zero real projects, zero real center_reps.
 * Seeded below at ~60% mapped → should receive reminders.
 */
const CENTER_A_ID = 4;
const CENTER_A_ACRONYM = 'CIFOR';

/**
 * Center B = CIMMYT (id=5): zero real projects, zero real center_reps.
 * Seeded below at 100% mapped → should be skipped (≥90% threshold).
 */
const CENTER_B_ID = 5;

// Test user email addresses (inserted directly via SQL)
const REP_A1_EMAIL = 'remind-e2e-a1@codeobia.com';
const REP_A2_EMAIL = 'remind-e2e-a2@codeobia.com';
const REP_B1_EMAIL = 'remind-e2e-b1@codeobia.com';

/**
 * Controlled "now" values — weekdays verified via MySQL DAYNAME():
 *   2026-06-08 → Monday   (daysUntilDeadline=4 → >3 → weekly gate → Monday=1 → FIRES)
 *   2026-05-26 → Tuesday  (daysUntilDeadline=17 → >3 → weekly gate → Tue≠1 → SKIPPED)
 *   2026-06-10 → Wednesday (daysUntilDeadline=2 → ≤3 → daily → FIRES)
 * Deadline: 2026-06-12
 */
const DEADLINE = '2026-06-12';
/** UTC Monday; deadline is 4 days away → weekly cadence fires. */
const MONDAY: Date = new Date('2026-06-08T09:00:00Z');
/** UTC Tuesday far from deadline (17 days) → weekly cadence skips. */
const TUESDAY_FAR: Date = new Date('2026-05-26T09:00:00Z');
/** UTC Wednesday; deadline is 2 days away → daily cadence fires. */
const WEDNESDAY: Date = new Date('2026-06-10T09:00:00Z');

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a test center_rep user directly via SQL.
 * Uses ON DUPLICATE KEY UPDATE so re-running the suite in a dirty DB
 * is safe. Returns the user id.
 */
async function insertCenterRep(
  ds: DataSource,
  email: string,
  primaryCenterId: number,
): Promise<number> {
  await ds.query(
    `INSERT INTO users (email, first_name, last_name, role, center_id, is_active, cognito_sub)
     VALUES (?, 'E2E', 'Reminder', 'center_rep', ?, 1, ?)
     ON DUPLICATE KEY UPDATE role='center_rep', center_id=?, is_active=1`,
    [email, primaryCenterId, `remind-sub-${email}`, primaryCenterId],
  );
  const rows = await ds.query<{ id: number }[]>(
    `SELECT id FROM users WHERE email = ?`,
    [email],
  );
  return rows[0].id;
}

/**
 * Registers a user↔center membership in user_centers (idempotent).
 * sort_order=0 → primary center (mirrors the primary center_id on users).
 */
async function linkUserCenter(
  ds: DataSource,
  userId: number,
  centerId: number,
  sortOrder = 0,
): Promise<void> {
  await ds.query(
    `INSERT INTO user_centers (user_id, center_id, sort_order)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)`,
    [userId, centerId, sortOrder],
  );
}

/**
 * Seeds one active project in the given center with a project_budgets
 * row (year=FY26) and, when agreedAllocation is provided, an
 * agreed project_mapping row so mappedPercent is predictable.
 *
 * Returns the created project id.
 */
async function seedProject(
  ds: DataSource,
  opts: {
    code: string;
    centerId: number;
    budgetAmount: number;
    /** If set, inserts a project_mappings row with status='agreed'. */
    agreedAllocation?: number;
  },
): Promise<number> {
  const adminId = 1; // pre-seeded admin user
  await ds.query(
    `INSERT INTO projects (code, name, status, center_id, created_by, total_budget)
     VALUES (?, ?, 'active', ?, ?, ?)`,
    [
      opts.code,
      `E2E Remind ${opts.code}`,
      opts.centerId,
      adminId,
      opts.budgetAmount,
    ],
  );
  const rows = await ds.query<{ id: number }[]>(
    `SELECT id FROM projects WHERE code = ?`,
    [opts.code],
  );
  const projectId = rows[0].id;

  // Budget row — year must match DEFAULT_BUDGET_YEAR ('FY26') in projects.service.ts
  await ds.query(
    `INSERT INTO project_budgets (project_id, year, version, account, amount)
     VALUES (?, 'FY26', 'E2E', 'E2E-TEST', ?)`,
    [projectId, opts.budgetAmount],
  );

  if (opts.agreedAllocation !== undefined) {
    await ds.query(
      `INSERT INTO project_mappings
         (project_id, program_id, allocation_percentage, status,
          center_agreed, program_agreed, initiated_by)
       VALUES (?, 1, ?, 'agreed', 1, 1, ?)`,
      [projectId, opts.agreedAllocation, adminId],
    );
  }

  return projectId;
}

/** Deletes only our template's email rows — leaves all others untouched. */
async function clearReminderEmails(ds: DataSource): Promise<void> {
  await ds.query(`DELETE FROM emails WHERE template_key = ?`, [TEMPLATE_KEY]);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MappingReminderService — e2e (real MySQL)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let service: MappingReminderService;

  let repA1Id: number;
  let repA2Id: number;
  let repB1Id: number;

  // Saved original system_settings so we can restore after the suite.
  let originalSettings: {
    email_enabled: number;
    deadline_enabled: number;
    deadline_date: string | null;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    ds = app.get(DataSource);
    service = app.get(MappingReminderService);

    // Snapshot current system_settings so afterAll can restore them.
    const settingsRows = await ds.query<(typeof originalSettings)[]>(
      `SELECT email_enabled, deadline_enabled, deadline_date FROM system_settings WHERE id = 1`,
    );
    originalSettings = settingsRows[0];

    // Arm system_settings: both toggles on, deadline = 2026-06-12.
    await ds.query(
      `UPDATE system_settings SET email_enabled=1, deadline_enabled=1, deadline_date=? WHERE id=1`,
      [DEADLINE],
    );

    // ---- Seed test users ----
    repA1Id = await insertCenterRep(ds, REP_A1_EMAIL, CENTER_A_ID);
    repA2Id = await insertCenterRep(ds, REP_A2_EMAIL, CENTER_A_ID);
    repB1Id = await insertCenterRep(ds, REP_B1_EMAIL, CENTER_B_ID);

    await linkUserCenter(ds, repA1Id, CENTER_A_ID, 0);
    await linkUserCenter(ds, repA2Id, CENTER_A_ID, 0);
    await linkUserCenter(ds, repB1Id, CENTER_B_ID, 0);

    // ---- Center A (CIFOR, id=4): seed at ~60% mapped ----
    // 5 projects × 100 000 budget × 60% agreed allocation
    // totalBudgetYear = 500 000
    // mappedBudget    = 300 000
    // mappedPercent   = 60.0  (well below 90 threshold)
    for (let i = 1; i <= 5; i++) {
      await seedProject(ds, {
        code: `${CODE_PREFIX}A-${i}`,
        centerId: CENTER_A_ID,
        budgetAmount: 100_000,
        agreedAllocation: 60,
      });
    }

    // ---- Center B (CIMMYT, id=5): seed at 100% mapped ----
    // 2 projects × 100 000 budget × 100% agreed allocation
    // totalBudgetYear = 200 000
    // mappedPercent   = 100.0  (above 90 threshold → skipped)
    for (let i = 1; i <= 2; i++) {
      await seedProject(ds, {
        code: `${CODE_PREFIX}B-${i}`,
        centerId: CENTER_B_ID,
        budgetAmount: 100_000,
        agreedAllocation: 100,
      });
    }
  }, 60_000);

  afterEach(async () => {
    // Remove reminder emails after each test so assertions start clean.
    await clearReminderEmails(ds);
  });

  afterAll(async () => {
    // Bottom-up FK-safe teardown.

    // 1. Emails — safety net (afterEach covers per-test, but last test
    //    leaves rows until afterAll runs).
    await clearReminderEmails(ds);

    // 2. Mapping negotiations → project_mappings → project_budgets → projects
    for (let i = 1; i <= 5; i++) {
      const code = `${CODE_PREFIX}A-${i}`;
      await ds.query(
        `DELETE mn FROM mapping_negotiations mn
           INNER JOIN project_mappings pm ON pm.id = mn.mapping_id
           INNER JOIN projects p ON p.id = pm.project_id
           WHERE p.code = ?`,
        [code],
      );
      await ds.query(
        `DELETE pm FROM project_mappings pm
           INNER JOIN projects p ON p.id = pm.project_id
           WHERE p.code = ?`,
        [code],
      );
      await ds.query(
        `DELETE pb FROM project_budgets pb
           INNER JOIN projects p ON p.id = pb.project_id
           WHERE p.code = ?`,
        [code],
      );
      await ds.query(`DELETE FROM projects WHERE code = ?`, [code]);
    }
    for (let i = 1; i <= 2; i++) {
      const code = `${CODE_PREFIX}B-${i}`;
      await ds.query(
        `DELETE mn FROM mapping_negotiations mn
           INNER JOIN project_mappings pm ON pm.id = mn.mapping_id
           INNER JOIN projects p ON p.id = pm.project_id
           WHERE p.code = ?`,
        [code],
      );
      await ds.query(
        `DELETE pm FROM project_mappings pm
           INNER JOIN projects p ON p.id = pm.project_id
           WHERE p.code = ?`,
        [code],
      );
      await ds.query(
        `DELETE pb FROM project_budgets pb
           INNER JOIN projects p ON p.id = pb.project_id
           WHERE p.code = ?`,
        [code],
      );
      await ds.query(`DELETE FROM projects WHERE code = ?`, [code]);
    }

    // 3. user_centers rows, then test users.
    for (const [email, centerId] of [
      [REP_A1_EMAIL, CENTER_A_ID],
      [REP_A2_EMAIL, CENTER_A_ID],
      [REP_B1_EMAIL, CENTER_B_ID],
    ] as [string, number][]) {
      const rows = await ds.query<{ id: number }[]>(
        `SELECT id FROM users WHERE email = ?`,
        [email],
      );
      if (rows.length) {
        await ds.query(
          `DELETE FROM user_centers WHERE user_id = ? AND center_id = ?`,
          [rows[0].id, centerId],
        );
        await ds.query(`DELETE FROM users WHERE id = ?`, [rows[0].id]);
      }
    }

    // 4. Restore system_settings so other suites aren't affected.
    await ds.query(
      `UPDATE system_settings
       SET email_enabled=?, deadline_enabled=?, deadline_date=?
       WHERE id=1`,
      [
        originalSettings.email_enabled,
        originalSettings.deadline_enabled,
        originalSettings.deadline_date ?? null,
      ],
    );

    await app.close();
  }, 30_000);

  // -------------------------------------------------------------------------
  // Helper: query reminder rows scoped to our two test centers only.
  // -------------------------------------------------------------------------

  async function reminderRowsFor(centerId: number) {
    return ds.query<
      {
        id: string;
        to_user_id: number;
        subject: string;
        body: string;
        status: string;
        body_format: string;
        template_key: string;
        metadata: Record<string, unknown> | string;
      }[]
    >(
      `SELECT id, to_user_id, subject, body, status, body_format, template_key, metadata
       FROM emails
       WHERE template_key = ?
         AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.centerId')) = ?
       ORDER BY id ASC`,
      [TEMPLATE_KEY, String(centerId)],
    );
  }

  // -------------------------------------------------------------------------
  // T1: Happy path — Monday, weekly cadence, both center-A reps notified
  // -------------------------------------------------------------------------

  it('T1: enqueues one email per active center-A rep on Monday (weekly cadence)', async () => {
    await service.runTick(MONDAY);

    const rows = await reminderRowsFor(CENTER_A_ID);
    const recipientIds = rows.map((r) => r.to_user_id);

    expect(recipientIds).toHaveLength(2);
    expect(recipientIds).toContain(repA1Id);
    expect(recipientIds).toContain(repA2Id);
  });

  // -------------------------------------------------------------------------
  // T2: Email row shape
  // -------------------------------------------------------------------------

  it('T2: enqueued rows have correct template_key, status, body_format, and metadata shape', async () => {
    await service.runTick(MONDAY);

    const rows = await reminderRowsFor(CENTER_A_ID);
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row.template_key).toBe('center_mapping_reminder');
      expect(row.status).toBe('queued');
      expect(row.body_format).toBe('html');

      const meta =
        typeof row.metadata === 'string'
          ? (JSON.parse(row.metadata) as Record<string, unknown>)
          : row.metadata;

      expect(meta.centerId).toBe(CENTER_A_ID);
      // reminderDate must match the UTC calendar day of MONDAY
      expect(meta.reminderDate).toBe('2026-06-08');
      // mappedPercent for CIFOR with our seed = exactly 60.0
      expect(meta.mappedPercent).toBe(60);
    }
  });

  // -------------------------------------------------------------------------
  // T3: Subject contains the center acronym
  // -------------------------------------------------------------------------

  it('T3: subject contains the center acronym', async () => {
    await service.runTick(MONDAY);

    const rows = await reminderRowsFor(CENTER_A_ID);
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row.subject).toContain(CENTER_A_ACRONYM); // 'CIFOR'
    }
  });

  // -------------------------------------------------------------------------
  // T4: Body content
  // -------------------------------------------------------------------------

  it('T4: HTML body contains mappedPercent value, 90% target, and center-name greeting', async () => {
    await service.runTick(MONDAY);

    const rows = await reminderRowsFor(CENTER_A_ID);
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      // mappedPercent = 60, formatPercent(60) strips trailing .0 → "60"
      expect(row.body).toContain('60');
      expect(row.body).toContain('90%');
      // buildBody writes: "Dear ${centerName} team,"
      expect(row.body).toMatch(/Dear .+ team,/);
    }
  });

  // -------------------------------------------------------------------------
  // T5: Idempotency — second runTick on the same day does not add rows
  // -------------------------------------------------------------------------

  it('T5: second runTick on the same day produces no new rows (idempotency)', async () => {
    await service.runTick(MONDAY);

    const after1 = await reminderRowsFor(CENTER_A_ID);
    expect(after1).toHaveLength(2);

    await service.runTick(MONDAY);

    const after2 = await reminderRowsFor(CENTER_A_ID);
    expect(after2).toHaveLength(2); // unchanged — idempotency check fired
  });

  // -------------------------------------------------------------------------
  // T6: Weekly cadence skip — Tuesday far from deadline produces no rows
  // -------------------------------------------------------------------------

  it('T6: Tuesday with >3 days until deadline is skipped (weekly cadence, non-Monday)', async () => {
    await service.runTick(TUESDAY_FAR);

    // No rows for either test center — the tick exited at the weekday gate
    const rowsA = await reminderRowsFor(CENTER_A_ID);
    const rowsB = await reminderRowsFor(CENTER_B_ID);

    expect(rowsA).toHaveLength(0);
    expect(rowsB).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T7: Daily cadence fires — Wednesday ≤3 days from deadline enqueues
  // -------------------------------------------------------------------------

  it('T7: Wednesday within ≤3-day window fires (daily cadence) and enqueues rows', async () => {
    await service.runTick(WEDNESDAY);

    const rows = await reminderRowsFor(CENTER_A_ID);
    expect(rows).toHaveLength(2);

    // reminderDate must reflect Wednesday's UTC date, not Monday's
    for (const row of rows) {
      const meta =
        typeof row.metadata === 'string'
          ? (JSON.parse(row.metadata) as Record<string, unknown>)
          : row.metadata;
      expect(meta.reminderDate).toBe('2026-06-10');
    }
  });

  // -------------------------------------------------------------------------
  // T8: 90%-threshold skip — center B (100% mapped) receives no rows
  // -------------------------------------------------------------------------

  it('T8: center at ≥90% mapped is skipped; only center-A reps receive emails', async () => {
    await service.runTick(MONDAY);

    // Center B (CIMMYT): 100% mapped → service must skip it entirely
    const rowsB = await reminderRowsFor(CENTER_B_ID);
    expect(rowsB).toHaveLength(0);

    // Center A (CIFOR): still below threshold → must have fired
    const rowsA = await reminderRowsFor(CENTER_A_ID);
    expect(rowsA.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // T9: email_enabled=false does NOT gate generation
  //
  // The reminder generator is decoupled from `system_settings.email_enabled`
  // — that toggle gates the dispatcher only. When emails are paused, rows
  // must still be enqueued on schedule so nothing is silently lost; they
  // publish automatically once the toggle is re-enabled. This test pins
  // that contract end-to-end against real MySQL.
  // -------------------------------------------------------------------------

  it('T9: still enqueues reminders when email_enabled=false (dispatcher is the kill switch)', async () => {
    // Flip the kill switch OFF while leaving every other gate armed.
    await ds.query(`UPDATE system_settings SET email_enabled=0 WHERE id=1`);
    try {
      await service.runTick(MONDAY);

      const rows = await reminderRowsFor(CENTER_A_ID);
      const recipientIds = rows.map((r) => r.to_user_id);

      // Both center-A reps must have rows queued exactly as T1 expects.
      expect(recipientIds).toHaveLength(2);
      expect(recipientIds).toContain(repA1Id);
      expect(recipientIds).toContain(repA2Id);

      // Rows must land in `queued` status — the dispatcher will pick
      // them up once email_enabled is flipped back on. They must NOT
      // have been auto-transitioned to any other state by the producer.
      for (const row of rows) {
        expect(row.status).toBe('queued');
        expect(row.template_key).toBe('center_mapping_reminder');
      }
    } finally {
      // Restore for any downstream assertions / afterAll cleanup.
      await ds.query(`UPDATE system_settings SET email_enabled=1 WHERE id=1`);
    }
  });
});
