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

/**
 * Template key written to `emails.template_key` for every row produced
 * by this service. Drives the per-recipient/per-day idempotency check
 * (same key + same `metadata.reminderDate` + same recipient = duplicate)
 * and future template-rendering layers.
 */
const TEMPLATE_KEY = 'program_mapping_reminder';

/**
 * Outcome summary returned by {@link ProgramMappingReminderService.runTick}.
 * Mirrors the center reminder's result so the admin "run now" endpoint can
 * surface exactly what a run produced (including why it produced nothing).
 */
export interface ProgramReminderTickResult {
  /** `true` when the tick reached the per-program loop. */
  ran: boolean;
  /** Total reminder rows enqueued across all programs this tick. */
  enqueued: number;
  /** Number of programs iterated (0 when a global gate fired first). */
  programsTotal: number;
  /** Programs that enqueued at least one reminder. */
  programsEnqueued: number;
  /**
   * Programs skipped by a stop condition (no mappings awaiting response /
   * no recipients) or because every recipient was already reminded today.
   */
  programsSkipped: number;
  /**
   * Why the tick produced nothing, when applicable:
   *  - `deadline_disabled` — the program deadline is not enabled / not set
   *  - `deadline_passed`   — the program deadline is already in the past
   *  - `error`             — the tick threw; see {@link message}
   * `null` when the tick ran normally (even if 0 rows were enqueued).
   */
  shortCircuit: 'deadline_disabled' | 'deadline_passed' | 'error' | null;
  /** Human-readable one-line summary, safe to surface in the admin UI. */
  message: string;
}

/**
 * Cron worker that enqueues **program-start** reminder emails to every
 * active `program_rep` user, telling them the response period has started
 * and they must respond to their pending mappings before the program
 * deadline.
 *
 * Cadence: **daily** until the program deadline. There is no weekly throttle
 * (unlike the center reminder) — programs respond on a short window, so the
 * email goes out every day from when the program deadline is enabled until
 * it passes.
 *
 * Stop conditions (per program):
 *  - `system_settings.program_deadline_enabled = false` or no date (global)
 *  - program deadline already passed (global)
 *  - program has no mapping awaiting its response (a `negotiating` mapping
 *    with `program_agreed = 0` on an active project) — nothing to nudge
 *  - program has no active `program_rep` recipients
 *
 * Idempotency: per (recipient, day), an `emails` row with
 * `template_key = 'program_mapping_reminder'` and
 * `metadata.reminderDate = todayIso` must not already exist.
 *
 * Like the center reminder, this is a **producer** only and deliberately
 * ignores the `system_settings.email_enabled` kill switch — that toggle
 * gates the dispatcher, not generation, so rows queued during a kill-switch
 * window publish automatically once email sending is re-enabled.
 */
@Injectable()
export class ProgramMappingReminderService {
  private readonly logger = new Logger(ProgramMappingReminderService.name);

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
   * Daily cron at 09:05 UTC (5 minutes after the center reminder so the two
   * runs don't contend for the same DB connections). Delegates to
   * {@link runTick} so e2e tests can drive the same logic directly.
   */
  @Cron('5 9 * * *', { name: 'program-mapping-reminder' })
  async handleCron(): Promise<void> {
    await this.runTick();
  }

  // ---------------------------------------------------------------------------
  // Public tick — driven by the cron, the admin endpoint, and e2e tests
  // ---------------------------------------------------------------------------

  /**
   * Single tick of the program reminder workflow. Public so the admin
   * "run now" endpoint and the e2e suite can call it directly.
   *
   * The optional `now` parameter lets tests pin the "current" timestamp.
   * The cadence is already daily, so there is no `force` option — every
   * other gate (deadline enabled/set/not-passed, per-program stop
   * conditions, per-recipient/per-day idempotency) always applies.
   */
  async runTick(now: Date = new Date()): Promise<ProgramReminderTickResult> {
    try {
      // ----- Step 1: global gates --------------------------------------------
      const settings = await this.settingsService.getSettings();

      if (!settings.programDeadlineEnabled || !settings.programDeadlineDate) {
        this.logger.log(
          'Program reminders skipped: program deadline is not enabled or not set',
        );
        return this.emptyResult(
          'deadline_disabled',
          'No reminders generated: the program deadline is not enabled or not set.',
        );
      }

      const todayIso = this.toIsoDate(now);
      const daysUntilDeadline = this.daysBetweenUtc(
        todayIso,
        settings.programDeadlineDate,
      );

      if (daysUntilDeadline < 0) {
        this.logger.log(
          `Program reminders skipped: deadline ${settings.programDeadlineDate} already passed`,
        );
        return this.emptyResult(
          'deadline_passed',
          `No reminders generated: the program deadline (${settings.programDeadlineDate}) has already passed.`,
        );
      }

      // ----- Step 2: iterate programs (sequential, isolated) -----------------
      const programs = await this.programRepository.find();
      this.logger.log(
        `Program reminders tick started: today=${todayIso}, deadline=${settings.programDeadlineDate}, ` +
          `daysUntilDeadline=${daysUntilDeadline}, programs=${programs.length}`,
      );

      let totalEnqueued = 0;
      let programsEnqueued = 0;

      for (const program of programs) {
        try {
          const enqueued = await this.processProgram(
            program,
            settings.programDeadlineDate,
            todayIso,
          );
          totalEnqueued += enqueued;
          if (enqueued > 0) programsEnqueued += 1;
        } catch (err) {
          // One bad program must not abort the whole tick.
          this.logger.error(
            `Failed to process program id=${program.id} (${program.name}): ${(err as Error).message}`,
            (err as Error).stack,
          );
        }
      }

      this.logger.log(
        `Program reminders tick complete: enqueued=${totalEnqueued} emails across ${programsEnqueued}/${programs.length} programs`,
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
            ? `Queued ${totalEnqueued} reminder${totalEnqueued === 1 ? '' : 's'} across ${programsEnqueued} of ${programs.length} program${programs.length === 1 ? '' : 's'}.`
            : 'No reminders queued: every program has no mappings awaiting a response, has no recipients, or was already reminded today.',
      };
    } catch (err) {
      this.logger.error(
        `Program reminders tick failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return this.emptyResult(
        'error',
        `Reminder run failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Builds a zero-enqueue {@link ProgramReminderTickResult} for a tick that
   * short-circuited at a global gate or threw before/at iteration.
   */
  private emptyResult(
    shortCircuit: ProgramReminderTickResult['shortCircuit'],
    message: string,
  ): ProgramReminderTickResult {
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
   * Processes a single program: applies the stop conditions, resolves
   * recipients, and enqueues one email per recipient not yet reminded today.
   *
   * Returns the number of rows enqueued for this program.
   */
  private async processProgram(
    program: Program,
    deadlineDate: string,
    todayIso: string,
  ): Promise<number> {
    // Stop: nothing awaiting this program's response. Sending "respond to
    // your mappings" when there are none is noise.
    const pending = await this.countPendingMappings(program.id);
    if (pending === 0) {
      this.logger.debug(
        `Program ${program.officialCode} (id=${program.id}) skipped: no mappings awaiting response`,
      );
      return 0;
    }

    // Recipients = every active program_rep whose `user_programs` membership
    // includes this program. Multi-program reps receive one email per program.
    const recipients = await this.resolveRecipients(program.id);
    if (recipients.length === 0) {
      this.logger.debug(
        `Program ${program.officialCode} (id=${program.id}) skipped: no active program_rep recipients`,
      );
      return 0;
    }

    const subject = this.buildSubject(program.name);
    const body = this.buildBody({
      programName: program.name,
      pendingMappings: pending,
      deadlineDate,
    });

    let enqueuedForProgram = 0;

    for (const recipient of recipients) {
      try {
        const alreadySent = await this.alreadyReminded(recipient.id, todayIso);
        if (alreadySent) {
          this.logger.debug(
            `Recipient userId=${recipient.id} for program ${program.officialCode} ` +
              `already reminded today (${todayIso}); skipping`,
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
            pendingMappings: pending,
            reminderDate: todayIso,
          },
        });

        enqueuedForProgram += 1;
      } catch (err) {
        // Per-recipient try/catch: one bad row must not abort the rest.
        this.logger.error(
          `Failed to enqueue program reminder for userId=${recipient.id} ` +
            `(program=${program.officialCode}): ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }

    if (enqueuedForProgram > 0) {
      this.logger.log(
        `Program ${program.officialCode} (id=${program.id}): enqueued ${enqueuedForProgram}/${recipients.length} reminder(s) ` +
          `(pendingMappings=${pending})`,
      );
    }

    return enqueuedForProgram;
  }

  // ---------------------------------------------------------------------------
  // Recipients / idempotency / counts
  // ---------------------------------------------------------------------------

  /**
   * Returns every active `program_rep` user whose `user_programs` membership
   * includes `programId`, using the `User.programs` ManyToMany relation
   * (materialises as a join through `user_programs`).
   *
   * camelCase property names per the CLAUDE.md TypeORM rule.
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
   * Counts the mappings on this program that are awaiting the program's
   * response: status `negotiating` with `program_agreed = 0`, on an active
   * project. These are the rows the program rep still has to act on.
   *
   * One parameterised query; bounded by the program's mapping rows.
   */
  private async countPendingMappings(programId: number): Promise<number> {
    const result = await this.emailRepository.manager
      .createQueryBuilder()
      .select('COUNT(*)', 'pending')
      .from('project_mappings', 'pm')
      .innerJoin(
        'projects',
        'p',
        "pm.project_id = p.id AND p.status = 'active'",
      )
      .where('pm.program_id = :programId', { programId })
      .andWhere("pm.status = 'negotiating'")
      .andWhere('pm.program_agreed = 0')
      .getRawOne<{ pending: string | number | null }>();

    const v = result?.pending;
    const n = typeof v === 'number' ? v : parseInt(String(v ?? '0'), 10);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Returns true when an `emails` row already exists for this recipient +
   * today with our template key. Uses JSON_EXTRACT against the existing
   * `metadata` column — no new column or index needed.
   */
  private async alreadyReminded(
    userId: number,
    todayIso: string,
  ): Promise<boolean> {
    const row = await this.emailRepository
      .createQueryBuilder('e')
      .select('e.id', 'id')
      .where('e.toUserId = :userId', { userId })
      .andWhere('e.templateKey = :tk', { tk: TEMPLATE_KEY })
      .andWhere(
        `JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.reminderDate')) = :today`,
        { today: todayIso },
      )
      .limit(1)
      .getRawOne();
    return !!row;
  }

  // ---------------------------------------------------------------------------
  // Subject / body assembly
  // ---------------------------------------------------------------------------

  /**
   * Subject line, mirroring the template: "Your Mapping Update – [Program]".
   */
  private buildSubject(programName: string): string {
    return `Your Mapping Update – ${programName}`;
  }

  /**
   * Renders the HTML body for the program-start reminder. Inline styles
   * only (webmail clients strip `<style>` blocks); 600px container; mirrors
   * the visual language of the center reminder. All interpolated values are
   * HTML-escaped via {@link escapeHtml}.
   */
  private buildBody(args: {
    programName: string;
    pendingMappings: number;
    deadlineDate: string;
  }): string {
    const programName = this.escapeHtml(args.programName);
    const pendingMappings = this.escapeHtml(String(args.pendingMappings));
    const deadlineFormatted = this.escapeHtml(
      this.formatLongDate(args.deadlineDate),
    );

    const toolUrl = 'https://project-mapping.cgiar.org/';
    const guideUrl =
      'https://sites.google.com/cgxchange.org/cgiarprhub/w3bilatproject-mapping?authuser=0';
    const supportEmail = 'PRMSTechSupport@cgiar.org';

    return `<!DOCTYPE html>
<html><body style="margin: 0; padding: 0; background: #faf9f9;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #faf9f9; padding: 16px 0;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background: #ffffff; border: 1px solid #e5e5e5; border-radius: 6px; font-family: Arial, Helvetica, sans-serif; color: #333; line-height: 1.5;">
      <tr><td style="padding: 24px 24px 8px 24px;">
        <h2 style="margin: 0 0 8px 0; color: #5569dd; font-size: 20px;">Your Mapping Update</h2>
        <p style="margin: 0; color: #777; font-size: 13px;">FY2026 CGIAR Project Registry &amp; Mapping Tool</p>
      </td></tr>

      <tr><td style="padding: 16px 24px 0 24px;">
        <p style="margin: 0 0 12px 0;">Dear ${programName} team,</p>
        <p style="margin: 0 0 12px 0;">We inform you that the response period for the P/As has started. Please ensure that you respond to all the mappings before the deadline below.</p>
        <p style="margin: 0 0 16px 0;">You currently have <strong>${pendingMappings}</strong> mapping${args.pendingMappings === 1 ? '' : 's'} awaiting your response.</p>
      </td></tr>

      <tr><td style="padding: 0 24px;">
        <p style="margin: 0 0 6px 0;"><strong>Access the tool:</strong> <a href="${toolUrl}" style="color: #5569dd; text-decoration: none;">${toolUrl}</a></p>
        <p style="margin: 0 0 16px 0;"><strong>Deadline to complete your mapping:</strong> ${deadlineFormatted}</p>
      </td></tr>

      <tr><td style="padding: 0 24px;">
        <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 8px 0 16px 0;">
      </td></tr>

      <tr><td style="padding: 0 24px 16px 24px;">
        <p style="margin: 0 0 16px 0;">A Quick Guide for Programs and resources for the 2026 W3/bilateral project mapping &mdash; including the timeline &mdash; are available in the <a href="${guideUrl}" style="color: #5569dd; text-decoration: none;">P&amp;R Hub</a>.</p>
        <p style="margin: 0 0 16px 0;">Questions? Contact the CGIAR Mapping Support Team at <a href="mailto:${supportEmail}" style="color: #5569dd; text-decoration: none;">${supportEmail}</a></p>
      </td></tr>

      <tr><td style="padding: 0 24px 24px 24px; border-top: 1px solid #e5e5e5;">
        <p style="margin: 16px 0 0 0; color: #777; font-size: 12px;">This is an automated notification. Please do not reply to this message.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers (no external utility packages — CLAUDE.md §2)
  // ---------------------------------------------------------------------------

  /** Today's UTC calendar day as a `YYYY-MM-DD` string. */
  private toIsoDate(date: Date): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * Calendar-day diff between two `YYYY-MM-DD` strings (UTC). Positive when
   * `toIso` is after `fromIso`.
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

  /** Formats a `YYYY-MM-DD` date as `DD Month YYYY` (e.g. `06 July 2026`). */
  private formatLongDate(yyyyMmDd: string): string {
    const y = Number(yyyyMmDd.slice(0, 4));
    const m = Number(yyyyMmDd.slice(5, 7));
    const d = Number(yyyyMmDd.slice(8, 10));
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  /** Minimal HTML escape for interpolated values. */
  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
