import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Email } from './entities/email.entity';
import { EmailBodyFormat } from './enums/email-body-format.enum';
import { EmailsService } from './emails.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Program } from '../reference-data/entities/program.entity';
import { SettingsService } from '../settings/settings.service';
import { ActorRole } from '../mappings/enums/actor-role.enum';

/**
 * Template key written to `emails.template_key` for every row produced by
 * this service — the program twin of `center_update_digest`. Used by the
 * idempotency check (same key + `metadata.digestDate` + same recipient +
 * same `metadata.programId` = duplicate, skip enqueue). Program scoping lets
 * a multi-program rep still receive one digest per program they represent.
 */
const TEMPLATE_KEY = 'program_update_digest';

/**
 * Per-project status label, computed from the **program** rep's perspective.
 */
type DigestProjectStatus =
  | 'Locked'
  | 'Awaiting your response'
  | 'In negotiation';

/**
 * A single project that saw activity in the trailing window (on a mapping
 * belonging to this program), as surfaced in the digest body.
 */
interface DigestProject {
  id: number;
  /** Display label — project name, falling back to code when name is null. */
  label: string;
  status: DigestProjectStatus;
}

/**
 * Outcome summary returned by {@link ProgramUpdateDigestService.runTick}.
 * Mirrors the center digest's result so the admin "run now" endpoint can
 * surface exactly what a manual run produced (including the reason a run
 * generated nothing — e.g. the digest is disabled or not yet due).
 */
export interface ProgramUpdateDigestTickResult {
  /**
   * `true` when the tick reached the per-program loop. `false` when a global
   * gate short-circuited it (see {@link shortCircuit}) or the tick threw.
   */
  ran: boolean;
  /** Total digest rows enqueued across all programs this tick. */
  enqueued: number;
  /** Number of programs iterated (0 when a global gate fired first). */
  programsTotal: number;
  /** Programs that enqueued at least one digest. */
  programsEnqueued: number;
  /**
   * Programs skipped (no updated projects / no recipients) or whose every
   * recipient was already sent today's digest.
   */
  programsSkipped: number;
  /**
   * Why the tick produced nothing, when applicable:
   *  - `disabled`      — the program digest toggle is off
   *  - `past_end_date` — today is past `program_update_digest_end_date`
   *  - `not_due`       — interval has not elapsed since the last run (cron
   *                      only; never returned for a `force` run)
   *  - `error`         — the tick threw; see {@link message}
   * `null` when the tick ran normally (even if 0 rows were enqueued).
   */
  shortCircuit: 'disabled' | 'past_end_date' | 'not_due' | 'error' | null;
  /** Human-readable one-line summary, safe to surface in the admin UI. */
  message: string;
}

/**
 * Cron worker that enqueues a "Notification of Updates" digest to every
 * active `program_rep` — the program-side twin of {@link UpdateDigestService}.
 * On a fixed cadence it tells a program which projects (scoped to that
 * program's mappings) saw activity — any `mapping_negotiations` row, chat
 * included — in the trailing window, with each project's current
 * program-side status.
 *
 * Cadence (UTC):
 *  - Runs daily at 09:10, but only **sends** when at least
 *    `program_update_digest_interval_days` whole days have elapsed since the
 *    last run that iterated programs (`program_update_digest_last_run_at`).
 *  - A manual/admin run (`runTick(now, { force: true })`) bypasses the
 *    interval/not-due check. It does NOT bypass the disabled or
 *    past-end-date gates.
 *
 * Stop conditions:
 *  - `program_update_digest_enabled = false` (global)
 *  - today is past `program_update_digest_end_date` (global)
 *  - program has 0 updated projects in the window (per program)
 *  - program has no active `program_rep` recipients (per program)
 *
 * Idempotency:
 *  - Per (recipient, day, program): an `emails` row with
 *    `template_key = 'program_update_digest'`,
 *    `metadata.digestDate = todayIso` and `metadata.programId = program.id`
 *    must not already exist.
 *
 * This service is a **producer** only — it drops rows on the queue.
 * Like the other reminder producers it deliberately ignores
 * `system_settings.email_enabled` so digest rows are always generated on
 * schedule; rows queued during a kill-switch window publish automatically
 * once email sending is re-enabled.
 */
@Injectable()
export class ProgramUpdateDigestService {
  private readonly logger = new Logger(ProgramUpdateDigestService.name);

  constructor(
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Program)
    private readonly programRepository: Repository<Program>,
    private readonly settingsService: SettingsService,
    private readonly emailsService: EmailsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cron entry point
  // ---------------------------------------------------------------------------

  /**
   * Daily cron at 09:10 UTC (after the center digest at 09:00 and the program
   * reminder at 09:05 so the runs don't contend for DB connections).
   * Delegates to {@link runTick} so e2e tests can drive the same logic
   * without waiting for the scheduler. The result is intentionally ignored on
   * the scheduled path — only the admin "run now" endpoint consumes it.
   */
  @Cron('10 9 * * *', { name: 'program-update-digest' })
  async handleCron(): Promise<void> {
    await this.runTick();
  }

  // ---------------------------------------------------------------------------
  // Public tick — driven by the cron and by the admin endpoint / e2e tests
  // ---------------------------------------------------------------------------

  /**
   * Single tick of the program digest workflow.
   *
   * `now` is injectable for tests that pin the "current" timestamp.
   * `options.force` (default `false`) bypasses the interval/not-due check so
   * an admin can generate digests on demand. The disabled and past-end-date
   * gates and the per-recipient/per-day idempotency guard still apply.
   */
  async runTick(
    now: Date = new Date(),
    options: { force?: boolean } = {},
  ): Promise<ProgramUpdateDigestTickResult> {
    const force = options.force ?? false;
    try {
      // ----- Step 1: global gates --------------------------------------------
      const settings = await this.settingsService.getSettings();

      if (!settings.programUpdateDigestEnabled) {
        this.logger.log('Program update digest skipped: digest is disabled');
        return this.emptyResult(
          'disabled',
          'No digest generated: the program Notification of Updates digest is disabled.',
        );
      }

      const todayIso = this.toIsoDate(now);

      // Past end date → stop sending. `force` does NOT bypass this.
      if (
        settings.programUpdateDigestEndDate &&
        todayIso > settings.programUpdateDigestEndDate
      ) {
        this.logger.log(
          `Program update digest skipped: today ${todayIso} is past the end date ${settings.programUpdateDigestEndDate}`,
        );
        return this.emptyResult(
          'past_end_date',
          `No digest generated: the program digest end date (${settings.programUpdateDigestEndDate}) has passed.`,
        );
      }

      // ----- Step 2: due check (skipped when forced) -------------------------

      if (
        !force &&
        !this.isDue(
          settings.programUpdateDigestLastRunAt,
          todayIso,
          settings.programUpdateDigestIntervalDays,
        )
      ) {
        const lastIso = settings.programUpdateDigestLastRunAt
          ? this.toIsoDate(settings.programUpdateDigestLastRunAt)
          : 'never';
        this.logger.debug(
          `Program update digest skipped: not due yet (lastRun=${lastIso}, interval=${settings.programUpdateDigestIntervalDays} day(s))`,
        );
        return this.emptyResult(
          'not_due',
          `No digest generated: the next program digest is not due yet (runs every ${settings.programUpdateDigestIntervalDays} day(s)). Use a manual run to send now.`,
        );
      }

      // ----- Step 3: iterate programs (sequential, isolated) -----------------

      const windowDays = settings.programUpdateDigestWindowDays;
      const programs = await this.programRepository.find();
      this.logger.log(
        `Program update digest tick started${force ? ' (forced)' : ''}: today=${todayIso}, ` +
          `windowDays=${windowDays}, interval=${settings.programUpdateDigestIntervalDays}, programs=${programs.length}`,
      );

      let totalEnqueued = 0;
      let programsEnqueued = 0;

      for (const program of programs) {
        try {
          const enqueued = await this.processProgram(
            program,
            windowDays,
            now,
            todayIso,
          );
          totalEnqueued += enqueued;
          if (enqueued > 0) programsEnqueued += 1;
        } catch (err) {
          // One bad program must not abort the whole tick.
          this.logger.error(
            `Failed to process program id=${program.id} (${program.officialCode ?? program.name}): ${(err as Error).message}`,
            (err as Error).stack,
          );
        }
      }

      // The tick "ran" (was due or forced) regardless of whether any row was
      // enqueued — so stamp the last-run anchor so the interval restarts.
      await this.settingsService.markProgramUpdateDigestRun(now);

      this.logger.log(
        `Program update digest tick complete: enqueued=${totalEnqueued} digest(s) across ${programsEnqueued}/${programs.length} programs`,
      );

      return {
        ran: true,
        enqueued: totalEnqueued,
        programsTotal: programs.length,
        programsEnqueued,
        programsSkipped: programs.length - programsEnqueued,
        shortCircuit: null,
        message:
          totalEnqueued > 0
            ? `Queued ${totalEnqueued} digest${totalEnqueued === 1 ? '' : 's'} across ${programsEnqueued} of ${programs.length} program${programs.length === 1 ? '' : 's'}.`
            : 'No digests queued: no program had updated projects in the window, or every recipient was already sent today.',
      };
    } catch (err) {
      this.logger.error(
        `Program update digest tick failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return this.emptyResult(
        'error',
        `Digest run failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Builds a zero-enqueue {@link ProgramUpdateDigestTickResult} for a tick
   * that short-circuited at a global gate or threw before/at iteration.
   */
  private emptyResult(
    shortCircuit: ProgramUpdateDigestTickResult['shortCircuit'],
    message: string,
  ): ProgramUpdateDigestTickResult {
    return {
      ran: false,
      enqueued: 0,
      programsTotal: 0,
      programsEnqueued: 0,
      programsSkipped: 0,
      shortCircuit,
      message,
    };
  }

  // ---------------------------------------------------------------------------
  // Per-program processing
  // ---------------------------------------------------------------------------

  /**
   * Processes a single program: finds the projects with activity on this
   * program's mappings in the window, resolves recipients, and enqueues one
   * digest per recipient not already sent today. Returns the number of rows
   * enqueued (0 when the program has no updated projects, no recipients, or
   * all recipients were already sent).
   */
  private async processProgram(
    program: Program,
    windowDays: number,
    now: Date,
    todayIso: string,
  ): Promise<number> {
    const projects = await this.findUpdatedProjects(
      program.id,
      windowDays,
      now,
    );

    // Stop: nothing changed for this program in the window — don't email.
    if (projects.length === 0) {
      this.logger.debug(
        `Program ${program.officialCode} (id=${program.id}) skipped: no updated projects in the last ${windowDays} day(s)`,
      );
      return 0;
    }

    const recipients = await this.resolveRecipients(program.id);
    if (recipients.length === 0) {
      this.logger.debug(
        `Program ${program.officialCode} (id=${program.id}) skipped: no active program_rep recipients`,
      );
      return 0;
    }

    const programLabel = program.officialCode || program.name;
    const subject = this.buildSubject(
      programLabel,
      projects.length,
      windowDays,
    );
    const body = this.buildBody({
      programName: program.name,
      windowDays,
      projects,
    });

    let enqueuedForProgram = 0;

    for (const recipient of recipients) {
      try {
        const alreadySent = await this.alreadyDigested(
          recipient.id,
          todayIso,
          program.id,
        );
        if (alreadySent) {
          this.logger.debug(
            `Recipient userId=${recipient.id} for program ${program.officialCode} ` +
              `already sent today's digest (${todayIso}); skipping`,
          );
          continue;
        }

        await this.emailsService.enqueue({
          toUserId: recipient.id,
          toEmail: recipient.email,
          subject,
          body,
          bodyFormat: EmailBodyFormat.HTML,
          templateKey: TEMPLATE_KEY,
          metadata: {
            programId: program.id,
            digestDate: todayIso,
            projectCount: projects.length,
            windowDays,
          },
        });

        enqueuedForProgram += 1;
      } catch (err) {
        // Per-recipient try/catch: one bad row must not abort the rest.
        this.logger.error(
          `Failed to enqueue program update digest for userId=${recipient.id} ` +
            `(program=${program.officialCode}): ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }

    if (enqueuedForProgram > 0) {
      this.logger.log(
        `Program ${program.officialCode} (id=${program.id}): enqueued ${enqueuedForProgram}/${recipients.length} digest(s) ` +
          `(${projects.length} updated project(s) in the last ${windowDays} day(s))`,
      );
    }

    return enqueuedForProgram;
  }

  // ---------------------------------------------------------------------------
  // Queries: updated projects / recipients / idempotency
  // ---------------------------------------------------------------------------

  /**
   * Returns the active projects that have ≥1 `mapping_negotiations` row
   * created on or after `now - windowDays` **on a mapping belonging to
   * `programId`**, with each project's program-side status. Chat messages are
   * rows in `mapping_negotiations`, so any event type counts as an "update".
   *
   * Status mirrors the program rep's perspective:
   *  - `negotiation_locked = 1`                                   → 'Locked'
   *  - else THIS program's non-removed mapping has (center_agreed=1 AND
   *    program_agreed=0 AND status='negotiating') → 'Awaiting your response'
   *    (the center has counter-proposed/agreed and the program has not)
   *  - else                                              → 'In negotiation'
   *
   * One parameterised query. Raw QueryBuilder against table names → snake_case
   * columns (same style the center digest uses).
   */
  private async findUpdatedProjects(
    programId: number,
    windowDays: number,
    now: Date,
  ): Promise<DigestProject[]> {
    // Window start = now - windowDays, as a JS Date so mysql2 binds it.
    const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

    const rows = await this.emailRepository.manager
      .createQueryBuilder()
      .select('p.id', 'id')
      .addSelect('p.name', 'name')
      .addSelect('p.code', 'code')
      .addSelect('p.negotiation_locked', 'locked')
      // Program-action flag across THIS program's non-removed mappings: the
      // center has acted (center_agreed=1) and the program hasn't.
      .addSelect(
        `MAX(CASE WHEN pm.status = 'negotiating' AND pm.center_agreed = 1 AND pm.program_agreed = 0
            THEN 1 ELSE 0 END)`,
        'awaitingProgram',
      )
      .from('projects', 'p')
      .innerJoin(
        'project_mappings',
        'pm',
        'pm.project_id = p.id AND pm.program_id = :programId',
        { programId },
      )
      // Exclude the program's own actions: a project only qualifies when the
      // recent activity came from the *other* side (center reps, admins). This
      // prevents programs being notified about updates they made themselves.
      .innerJoin(
        'mapping_negotiations',
        'mn',
        'mn.mapping_id = pm.id AND mn.created_at >= :windowStart AND mn.actor_role != :excludeRole',
        { windowStart, excludeRole: ActorRole.PROGRAM_REP },
      )
      .where("p.status = 'active'")
      .groupBy('p.id')
      .addGroupBy('p.name')
      .addGroupBy('p.code')
      .addGroupBy('p.negotiation_locked')
      .getRawMany<{
        id: number | string;
        name: string | null;
        code: string | null;
        locked: number | string | boolean;
        awaitingProgram: number | string | null;
      }>();

    return rows.map((r) => {
      const id = typeof r.id === 'number' ? r.id : parseInt(String(r.id), 10);
      const locked = Boolean(Number(r.locked));
      const awaiting = Boolean(Number(r.awaitingProgram ?? 0));
      const status: DigestProjectStatus = locked
        ? 'Locked'
        : awaiting
          ? 'Awaiting your response'
          : 'In negotiation';
      return {
        id,
        // Prefer the project name; fall back to its code, then the id.
        label: r.name ?? r.code ?? `Project ${id}`,
        status,
      };
    });
  }

  /**
   * Returns every active `program_rep` whose `user_programs` membership
   * includes `programId`. camelCase property names per the CLAUDE.md TypeORM
   * rule (this is an entity QueryBuilder, unlike `findUpdatedProjects`).
   */
  private async resolveRecipients(
    programId: number,
  ): Promise<Array<{ id: number; email: string }>> {
    return this.userRepository
      .createQueryBuilder('user')
      .innerJoin('user.programs', 'p', 'p.id = :programId', { programId })
      .where('user.role = :role', { role: UserRole.PROGRAM_REP })
      .andWhere('user.isActive = true')
      .andWhere('user.email IS NOT NULL')
      .select(['user.id', 'user.email'])
      .getMany();
  }

  /**
   * Returns true when a digest `emails` row already exists for this recipient
   * + today + program with our template key. Uses JSON_EXTRACT + JSON_UNQUOTE
   * (no new column / index) — bounded by the `(to_user_id)` index.
   */
  private async alreadyDigested(
    userId: number,
    todayIso: string,
    programId: number,
  ): Promise<boolean> {
    const row = await this.emailRepository
      .createQueryBuilder('e')
      .select('e.id', 'id')
      .where('e.toUserId = :userId', { userId })
      .andWhere('e.templateKey = :tk', { tk: TEMPLATE_KEY })
      .andWhere(
        `JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.digestDate')) = :today`,
        { today: todayIso },
      )
      .andWhere(
        `JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.programId')) = :programId`,
        { programId: String(programId) },
      )
      .limit(1)
      .getRawOne();
    return !!row;
  }

  // ---------------------------------------------------------------------------
  // Due-check helper
  // ---------------------------------------------------------------------------

  /**
   * True when the digest is due: never run before, or at least
   * `intervalDays` whole UTC calendar days have elapsed since the last run.
   */
  private isDue(
    lastRunAt: Date | null,
    todayIso: string,
    intervalDays: number,
  ): boolean {
    if (!lastRunAt) return true;
    const lastIso = this.toIsoDate(lastRunAt);
    return this.daysBetweenUtc(lastIso, todayIso) >= intervalDays;
  }

  // ---------------------------------------------------------------------------
  // Subject / body assembly
  // ---------------------------------------------------------------------------

  /**
   * Subject line. Uses the program's official code (or name) to stay compact
   * in mobile inbox clients, e.g.
   * "PRMS — 3 project update(s) in INIT-01 (last 2 days)".
   */
  private buildSubject(
    programLabel: string,
    count: number,
    windowDays: number,
  ): string {
    return `PRMS — ${count} project update(s) in ${programLabel} (last ${windowDays} days)`;
  }

  /**
   * Renders the HTML body. Inline styles only — webmail clients routinely
   * strip `<style>` blocks. 600 px container; mirrors the center digest body.
   * All interpolated values are HTML-escaped via {@link escapeHtml}.
   */
  private buildBody(args: {
    programName: string;
    windowDays: number;
    projects: DigestProject[];
  }): string {
    const programName = this.escapeHtml(args.programName);
    const windowDays = this.escapeHtml(String(args.windowDays));

    const toolUrl = 'https://project-mapping.cgiar.org/';
    const guideUrl =
      'https://sites.google.com/cgxchange.org/cgiarprhub/w3bilatproject-mapping?authuser=0';
    // "Quick guide for Programs" Word document on CGIAR SharePoint. Rendered as
    // clickable text — escapeHtml() keeps the href valid HTML. Mirrors the
    // program mapping-reminder email.
    const quickGuideUrl =
      'https://cgiar.sharepoint.com/:w:/s/PPUInterim/IQA3VQUvR-JBRpPVZ5sBdpGZAay7-fmh0er27nacRqloGY0?e=q9QAlm';
    const quickGuideHref = this.escapeHtml(quickGuideUrl);
    const supportEmail = 'PRMSTechSupport@cgiar.org';

    // One row per updated project: a link to the project's negotiation/mapping
    // view + its status badge. Colours mirror the dashboard status semantics.
    const rowsHtml = args.projects
      .map((project) => {
        const href = this.escapeHtml(
          `https://project-mapping.cgiar.org/mappings/project/${project.id}`,
        );
        const label = this.escapeHtml(project.label);
        const { color, bg } = this.statusColors(project.status);
        const statusLabel = this.escapeHtml(project.status);
        return `<tr>
              <td style="padding: 8px 0; border-bottom: 1px solid #eee;">
                <a href="${href}" style="color: #5569dd; text-decoration: none; font-weight: bold;">${label}</a>
              </td>
              <td style="padding: 8px 0; border-bottom: 1px solid #eee; text-align: right; white-space: nowrap;">
                <span style="display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; color: ${color}; background: ${bg};">${statusLabel}</span>
              </td>
            </tr>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html><body style="margin: 0; padding: 0; background: #faf9f9;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #faf9f9; padding: 16px 0;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background: #ffffff; border: 1px solid #e5e5e5; border-radius: 6px; font-family: Arial, Helvetica, sans-serif; color: #333; line-height: 1.5;">
      <tr><td style="padding: 24px 24px 8px 24px;">
        <h2 style="margin: 0 0 8px 0; color: #5569dd; font-size: 20px;">Notification of Updates</h2>
        <p style="margin: 0; color: #777; font-size: 13px;">FY2026 CGIAR Project Registry &amp; Mapping Tool</p>
      </td></tr>

      <tr><td style="padding: 16px 24px 0 24px;">
        <p style="margin: 0 0 12px 0;">Dear ${programName} team,</p>
        <p style="margin: 0 0 16px 0;">The following project(s) mapped to your program saw activity in the last ${windowDays} day(s). Open each to review the latest negotiation events and chat.</p>
      </td></tr>

      <tr><td style="padding: 0 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse: collapse;">
          ${rowsHtml}
        </table>
      </td></tr>

      <tr><td style="padding: 16px 24px 0 24px;">
        <p style="margin: 0 0 16px 0;"><strong>Access the tool:</strong> <a href="${toolUrl}" style="color: #5569dd; text-decoration: none;">${toolUrl}</a></p>
      </td></tr>

      <tr><td style="padding: 0 24px;">
        <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 8px 0 16px 0;">
      </td></tr>

      <tr><td style="padding: 0 24px 16px 24px;">
        <p style="margin: 0 0 8px 0;"><strong>Quick Guide for Programs</strong></p>
        <p style="margin: 0 0 16px 0;">A step-by-step guide for programs is <a href="${quickGuideHref}" style="color: #5569dd; text-decoration: none;">available</a> as a Word document.</p>
        <p style="margin: 0 0 16px 0;">Resources for the 2026 W3/bilateral project mapping &mdash; including the timeline &mdash; are available in the <a href="${guideUrl}" style="color: #5569dd; text-decoration: none;">P&amp;R Hub</a>.</p>
        <p style="margin: 0 0 16px 0;">Questions? Contact the CGIAR PRMS Support Team at <a href="mailto:${supportEmail}" style="color: #5569dd; text-decoration: none;">${supportEmail}</a></p>
      </td></tr>

      <tr><td style="padding: 0 24px 24px 24px; border-top: 1px solid #e5e5e5;">
        <p style="margin: 16px 0 0 0; color: #777; font-size: 12px;">This is an automated notification. Please do not reply to this message.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  }

  /**
   * Maps a status label to a (text colour, background) pair for the inline
   * status badge. Mirrors the dashboard palette: green for locked, amber for
   * "needs program action", blue for in-negotiation.
   */
  private statusColors(status: DigestProjectStatus): {
    color: string;
    bg: string;
  } {
    switch (status) {
      case 'Locked':
        return { color: '#2e7d32', bg: '#e8f5e9' };
      case 'Awaiting your response':
        return { color: '#b26a00', bg: '#fff3e0' };
      case 'In negotiation':
      default:
        return { color: '#5569dd', bg: '#eef0fb' };
    }
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers (no external utility packages — CLAUDE.md §2)
  // ---------------------------------------------------------------------------

  /**
   * Returns a `Date`'s UTC calendar day as a `YYYY-MM-DD` string. UTC
   * accessors give a stable day boundary regardless of server timezone and
   * match the `metadata.digestDate` written on the row.
   */
  private toIsoDate(date: Date): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * Calendar-day diff between two `YYYY-MM-DD` strings, computed in UTC so
   * DST shifts don't add or drop a day. Positive when `toIso` is after
   * `fromIso`.
   */
  private daysBetweenUtc(fromIso: string, toIso: string): number {
    const from = Date.UTC(
      Number(fromIso.slice(0, 4)),
      Number(fromIso.slice(5, 7)) - 1,
      Number(fromIso.slice(8, 10)),
    );
    const to = Date.UTC(
      Number(toIso.slice(0, 4)),
      Number(toIso.slice(5, 7)) - 1,
      Number(toIso.slice(8, 10)),
    );
    return Math.round((to - from) / 86_400_000);
  }

  /**
   * Minimal HTML escape for values interpolated into the email body.
   */
  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
