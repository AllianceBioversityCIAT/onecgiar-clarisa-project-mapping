import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Email } from './entities/email.entity';
import { EmailBodyFormat } from './enums/email-body-format.enum';
import { EmailsService } from './emails.service';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { Center } from '../reference-data/entities/center.entity';
import { SettingsService } from '../settings/settings.service';

/**
 * Template key written to `emails.template_key` for every row produced by
 * this service. Used by the idempotency check (same key +
 * `metadata.digestDate` + same recipient + same `metadata.centerId` =
 * duplicate, skip enqueue). Center scoping lets a multi-center rep still
 * receive one digest per center they represent.
 */
const TEMPLATE_KEY = 'center_update_digest';

/**
 * Per-project status label, computed from the center's perspective with the
 * same SQL semantics the dashboard allocation widget uses.
 */
type DigestProjectStatus =
  | 'Locked'
  | 'Awaiting your response'
  | 'In negotiation';

/**
 * A single project that saw activity in the trailing window, as surfaced in
 * the digest body.
 */
interface DigestProject {
  id: number;
  /** Display label — project name, falling back to code when name is null. */
  label: string;
  status: DigestProjectStatus;
}

/**
 * Outcome summary returned by {@link UpdateDigestService.runTick}. Mirrors
 * `ReminderTickResult` from `mapping-reminder.service.ts`: the cron handler
 * ignores it; the admin "run now" endpoint surfaces it so an admin can see
 * exactly what a manual run produced (including the reason a run generated
 * nothing — e.g. the digest is disabled or not yet due).
 */
export interface UpdateDigestTickResult {
  /**
   * `true` when the tick reached the per-center loop. `false` when a global
   * gate short-circuited it (see {@link shortCircuit}) or the tick threw.
   */
  ran: boolean;
  /** Total digest rows enqueued across all centers this tick. */
  enqueued: number;
  /** Number of centers iterated (0 when a global gate fired first). */
  centersTotal: number;
  /** Centers that enqueued at least one digest. */
  centersEnqueued: number;
  /**
   * Centers skipped (no updated projects / no recipients) or whose every
   * recipient was already sent today's digest.
   */
  centersSkipped: number;
  /**
   * Why the tick produced nothing, when applicable:
   *  - `disabled`      — the digest toggle is off
   *  - `past_end_date` — today is past `update_digest_end_date` (stop sending)
   *  - `not_due`       — interval has not elapsed since the last run (cron
   *                      only; never returned for a `force` run)
   *  - `error`         — the tick threw; see {@link message}
   * `null` when the tick ran normally (even if 0 rows were enqueued because
   * no center had any updated projects).
   */
  shortCircuit: 'disabled' | 'past_end_date' | 'not_due' | 'error' | null;
  /** Human-readable one-line summary, safe to surface in the admin UI. */
  message: string;
}

/**
 * Cron worker that enqueues a "Notification of Updates" digest to every
 * active `center_rep`. On a fixed cadence it tells a center which of its
 * projects saw activity — any `mapping_negotiations` row, chat included —
 * in the trailing window, with each project's current center-side status.
 *
 * Cadence (UTC):
 *  - Runs daily at 09:00, but only **sends** when at least
 *    `update_digest_interval_days` whole days have elapsed since the last
 *    run that iterated centers (`update_digest_last_run_at`).
 *  - A manual/admin run (`runTick(now, { force: true })`) bypasses the
 *    interval/not-due check so digests generate on demand. It does NOT
 *    bypass the disabled or past-end-date gates — a manual run after the
 *    end date must still not send.
 *
 * Stop conditions:
 *  - `update_digest_enabled = false` (global)
 *  - today is past `update_digest_end_date` (global)
 *  - center has 0 updated projects in the window (per center)
 *  - center has no active `center_rep` recipients (per center)
 *
 * Idempotency:
 *  - Per (recipient, day, center): an `emails` row with
 *    `template_key = 'center_update_digest'`,
 *    `metadata.digestDate = todayIso` and `metadata.centerId = center.id`
 *    must not already exist. Center scoping lets a multi-center rep get one
 *    digest per center per day. Implemented with a JSON_EXTRACT lookup
 *    against the existing `metadata` column — no schema change.
 *
 * This service is a **producer** only — it drops rows on the queue.
 * Actual delivery is the responsibility of `EmailsDispatchService`. Like the
 * other reminder producers it deliberately ignores
 * `system_settings.email_enabled` so digest rows are always generated on
 * schedule; rows queued during a kill-switch window publish automatically
 * once email sending is re-enabled.
 */
@Injectable()
export class UpdateDigestService {
  private readonly logger = new Logger(UpdateDigestService.name);

  constructor(
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Center)
    private readonly centerRepository: Repository<Center>,
    private readonly settingsService: SettingsService,
    private readonly emailsService: EmailsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cron entry point
  // ---------------------------------------------------------------------------

  /**
   * Daily cron at 09:00 UTC. Delegates to {@link runTick} so e2e tests can
   * drive the same logic without waiting for the scheduler. The result is
   * intentionally ignored on the scheduled path — only the admin "run now"
   * endpoint consumes it.
   */
  @Cron('0 9 * * *', { name: 'update-digest' })
  async handleCron(): Promise<void> {
    await this.runTick();
  }

  // ---------------------------------------------------------------------------
  // Public tick — driven by the cron and by the admin endpoint / e2e tests
  // ---------------------------------------------------------------------------

  /**
   * Single tick of the digest workflow.
   *
   * `now` is injectable for tests that pin the "current" timestamp.
   * `options.force` (default `false`) bypasses the interval/not-due check so
   * an admin can generate digests on demand. The disabled and past-end-date
   * gates and the per-recipient/per-day idempotency guard still apply.
   *
   * A top-level try/catch protects the cron handler — an unexpected error in
   * one tick must not abort `@nestjs/schedule` — and is folded into the
   * returned summary (`shortCircuit: 'error'`).
   */
  async runTick(
    now: Date = new Date(),
    options: { force?: boolean } = {},
  ): Promise<UpdateDigestTickResult> {
    const force = options.force ?? false;
    try {
      // ----- Step 1: global gates --------------------------------------------
      //
      // NOTE: `system_settings.email_enabled` is intentionally NOT read here
      // (same rationale as the reminder producers — the dispatcher owns that
      // kill switch).
      const settings = await this.settingsService.getSettings();

      if (!settings.updateDigestEnabled) {
        this.logger.log('Update digest skipped: digest is disabled');
        return this.emptyResult(
          'disabled',
          'No digest generated: the Notification of Updates digest is disabled.',
        );
      }

      const todayIso = this.toIsoDate(now);

      // Past end date → stop sending. `force` does NOT bypass this: a manual
      // run after the end date must still not send.
      if (
        settings.updateDigestEndDate &&
        todayIso > settings.updateDigestEndDate
      ) {
        this.logger.log(
          `Update digest skipped: today ${todayIso} is past the end date ${settings.updateDigestEndDate}`,
        );
        return this.emptyResult(
          'past_end_date',
          `No digest generated: the digest end date (${settings.updateDigestEndDate}) has passed.`,
        );
      }

      // ----- Step 2: due check (skipped when forced) -------------------------

      if (
        !force &&
        !this.isDue(
          settings.updateDigestLastRunAt,
          todayIso,
          settings.updateDigestIntervalDays,
        )
      ) {
        const lastIso = settings.updateDigestLastRunAt
          ? this.toIsoDate(settings.updateDigestLastRunAt)
          : 'never';
        this.logger.debug(
          `Update digest skipped: not due yet (lastRun=${lastIso}, interval=${settings.updateDigestIntervalDays} day(s))`,
        );
        return this.emptyResult(
          'not_due',
          `No digest generated: the next digest is not due yet (runs every ${settings.updateDigestIntervalDays} day(s)). Use a manual run to send now.`,
        );
      }

      // ----- Step 3: iterate centers (sequential, isolated) ------------------

      const windowDays = settings.updateDigestWindowDays;
      const centers = await this.centerRepository.find();
      this.logger.log(
        `Update digest tick started${force ? ' (forced)' : ''}: today=${todayIso}, ` +
          `windowDays=${windowDays}, interval=${settings.updateDigestIntervalDays}, centers=${centers.length}`,
      );

      let totalEnqueued = 0;
      let centersEnqueued = 0;

      for (const center of centers) {
        try {
          const enqueued = await this.processCenter(
            center,
            windowDays,
            now,
            todayIso,
          );
          totalEnqueued += enqueued;
          if (enqueued > 0) centersEnqueued += 1;
        } catch (err) {
          // One bad center must not abort the whole tick.
          this.logger.error(
            `Failed to process center id=${center.id} (${center.acronym ?? center.name}): ${(err as Error).message}`,
            (err as Error).stack,
          );
        }
      }

      // The tick "ran" (was due or forced) regardless of whether any row was
      // enqueued — so stamp the last-run anchor so the interval restarts.
      await this.settingsService.markUpdateDigestRun(now);

      this.logger.log(
        `Update digest tick complete: enqueued=${totalEnqueued} digest(s) across ${centersEnqueued}/${centers.length} centers`,
      );

      return {
        ran: true,
        enqueued: totalEnqueued,
        centersTotal: centers.length,
        centersEnqueued,
        centersSkipped: centers.length - centersEnqueued,
        shortCircuit: null,
        message:
          totalEnqueued > 0
            ? `Queued ${totalEnqueued} digest${totalEnqueued === 1 ? '' : 's'} across ${centersEnqueued} of ${centers.length} center${centers.length === 1 ? '' : 's'}.`
            : 'No digests queued: no center had updated projects in the window, or every recipient was already sent today.',
      };
    } catch (err) {
      this.logger.error(
        `Update digest tick failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return this.emptyResult(
        'error',
        `Digest run failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Builds a zero-enqueue {@link UpdateDigestTickResult} for a tick that
   * short-circuited at a global gate or threw before/at iteration.
   */
  private emptyResult(
    shortCircuit: UpdateDigestTickResult['shortCircuit'],
    message: string,
  ): UpdateDigestTickResult {
    return {
      ran: false,
      enqueued: 0,
      centersTotal: 0,
      centersEnqueued: 0,
      centersSkipped: 0,
      shortCircuit,
      message,
    };
  }

  // ---------------------------------------------------------------------------
  // Per-center processing
  // ---------------------------------------------------------------------------

  /**
   * Processes a single center: finds its projects updated in the window,
   * resolves recipients, and enqueues one digest per recipient not already
   * sent today. Returns the number of rows enqueued (0 when the center has no
   * updated projects, no recipients, or all recipients were already sent).
   */
  private async processCenter(
    center: Center,
    windowDays: number,
    now: Date,
    todayIso: string,
  ): Promise<number> {
    const projects = await this.findUpdatedProjects(center.id, windowDays, now);

    // Stop: nothing changed for this center in the window — don't email.
    if (projects.length === 0) {
      this.logger.debug(
        `Center ${center.acronym} (id=${center.id}) skipped: no updated projects in the last ${windowDays} day(s)`,
      );
      return 0;
    }

    const recipients = await this.resolveRecipients(center.id);
    if (recipients.length === 0) {
      this.logger.debug(
        `Center ${center.acronym} (id=${center.id}) skipped: no active center_rep recipients`,
      );
      return 0;
    }

    const subject = this.buildSubject(
      center.acronym,
      projects.length,
      windowDays,
    );
    const body = this.buildBody({
      centerName: center.name,
      windowDays,
      projects,
    });

    let enqueuedForCenter = 0;

    for (const recipient of recipients) {
      try {
        const alreadySent = await this.alreadyDigested(
          recipient.id,
          todayIso,
          center.id,
        );
        if (alreadySent) {
          this.logger.debug(
            `Recipient userId=${recipient.id} for center ${center.acronym} ` +
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
            centerId: center.id,
            digestDate: todayIso,
            projectCount: projects.length,
            windowDays,
          },
        });

        enqueuedForCenter += 1;
      } catch (err) {
        // Per-recipient try/catch: one bad row must not abort the rest.
        this.logger.error(
          `Failed to enqueue update digest for userId=${recipient.id} ` +
            `(center=${center.acronym}): ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }

    if (enqueuedForCenter > 0) {
      this.logger.log(
        `Center ${center.acronym} (id=${center.id}): enqueued ${enqueuedForCenter}/${recipients.length} digest(s) ` +
          `(${projects.length} updated project(s) in the last ${windowDays} day(s))`,
      );
    }

    return enqueuedForCenter;
  }

  // ---------------------------------------------------------------------------
  // Queries: updated projects / recipients / idempotency
  // ---------------------------------------------------------------------------

  /**
   * Returns the active projects in `centerId` that have ≥1
   * `mapping_negotiations` row created on or after `now - windowDays`, with
   * each project's center-side status. Chat messages are rows in
   * `mapping_negotiations`, so any event type counts as an "update".
   *
   * Status mirrors the dashboard allocation widget semantics:
   *  - `negotiation_locked = 1`                                   → 'Locked'
   *  - else any non-removed mapping with (program_agreed=1 AND
   *    center_agreed=0 AND status='negotiating') OR removal_requested=1
   *                                                  → 'Awaiting your response'
   *  - else                                              → 'In negotiation'
   *
   * One parameterised query. camelCase is irrelevant here — this is a raw
   * QueryBuilder against table names, so snake_case columns are used (the
   * same style mapping-reminder uses for its `countProjectsByMappingState`).
   */
  private async findUpdatedProjects(
    centerId: number,
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
      // Center-action flag across this project's non-removed mappings.
      .addSelect(
        `MAX(CASE WHEN pm.status != 'removed' AND (
            (pm.status = 'negotiating' AND pm.program_agreed = 1 AND pm.center_agreed = 0)
            OR pm.removal_requested = 1
          ) THEN 1 ELSE 0 END)`,
        'awaitingCenter',
      )
      .from('projects', 'p')
      .innerJoin('project_mappings', 'pm', 'pm.project_id = p.id')
      .innerJoin(
        'mapping_negotiations',
        'mn',
        'mn.mapping_id = pm.id AND mn.created_at >= :windowStart',
        { windowStart },
      )
      .where('p.center_id = :centerId', { centerId })
      .andWhere("p.status = 'active'")
      .groupBy('p.id')
      .addGroupBy('p.name')
      .addGroupBy('p.code')
      .addGroupBy('p.negotiation_locked')
      .getRawMany<{
        id: number | string;
        name: string | null;
        code: string | null;
        locked: number | string | boolean;
        awaitingCenter: number | string | null;
      }>();

    return rows.map((r) => {
      const id = typeof r.id === 'number' ? r.id : parseInt(String(r.id), 10);
      const locked = Boolean(Number(r.locked));
      const awaiting = Boolean(Number(r.awaitingCenter ?? 0));
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
   * Returns every active `center_rep` whose `user_centers` membership
   * includes `centerId`. camelCase property names per the CLAUDE.md TypeORM
   * rule (this is an entity QueryBuilder, unlike `findUpdatedProjects`).
   */
  private async resolveRecipients(
    centerId: number,
  ): Promise<Array<{ id: number; email: string }>> {
    return this.userRepository
      .createQueryBuilder('user')
      .innerJoin('user.centers', 'c', 'c.id = :centerId', { centerId })
      .where('user.role = :role', { role: UserRole.CENTER_REP })
      .andWhere('user.isActive = true')
      .andWhere('user.email IS NOT NULL')
      .select(['user.id', 'user.email'])
      .getMany();
  }

  /**
   * Returns true when a digest `emails` row already exists for this recipient
   * + today + center with our template key. Uses JSON_EXTRACT + JSON_UNQUOTE
   * (no new column / index) — bounded by the `(to_user_id)` index.
   */
  private async alreadyDigested(
    userId: number,
    todayIso: string,
    centerId: number,
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
        `JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.centerId')) = :centerId`,
        { centerId: String(centerId) },
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
   * Subject line. Uses the center's acronym to stay compact in mobile inbox
   * clients, e.g. "PRMS — 3 project update(s) in CIAT (last 2 days)".
   */
  private buildSubject(
    centerAcronym: string,
    count: number,
    windowDays: number,
  ): string {
    return `PRMS — ${count} project update(s) in ${centerAcronym} (last ${windowDays} days)`;
  }

  /**
   * Renders the HTML body. Inline styles only — webmail clients routinely
   * strip `<style>` blocks. 600 px container, sans-serif; mirrors the visual
   * language of the mapping-reminder body. All interpolated values are
   * HTML-escaped via {@link escapeHtml}.
   */
  private buildBody(args: {
    centerName: string;
    windowDays: number;
    projects: DigestProject[];
  }): string {
    const centerName = this.escapeHtml(args.centerName);
    const windowDays = this.escapeHtml(String(args.windowDays));

    const toolUrl = 'https://project-mapping.cgiar.org/';
    const guideUrl =
      'https://sites.google.com/cgxchange.org/cgiarprhub/w3bilatproject-mapping?authuser=0';
    // "Quick guide for Centers" Word document on CGIAR SharePoint. Rendered as
    // clickable text — the raw URL is long and full of query params, so it is
    // never shown verbatim. escapeHtml() encodes the '&' query separators so
    // the href stays valid HTML. Mirrors the center mapping-reminder email.
    const quickGuideUrl =
      'https://cgiar-my.sharepoint.com/:w:/r/personal/v_decol_cgiar_org/Documents/CGIAR%20Project%20Mapping%20Tool/CGIAR%20Project%20Registry%20%26%20Mapping%20Tool_Quick%20guide%20for%20Centers_V2.docx?d=wb1bc8df5e8514b229d44157db87db332&csf=1&web=1&e=f1auPn';
    const quickGuideHref = this.escapeHtml(quickGuideUrl);
    const supportEmail = 'PRMSTechSupport@cgiar.org';

    // One row per updated project: a link to the project's negotiation/mapping
    // view + its status badge. Colours mirror the dashboard status semantics
    // (green=agreed/locked, amber=needs center action, blue=in negotiation).
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
        <p style="margin: 0 0 12px 0;">Dear ${centerName} team,</p>
        <p style="margin: 0 0 16px 0;">The following project(s) in your portfolio saw activity in the last ${windowDays} day(s). Open each to review the latest negotiation events and chat.</p>
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
        <p style="margin: 0 0 8px 0;"><strong>Quick Guide for Centers</strong></p>
        <p style="margin: 0 0 16px 0;">A <a href="${quickGuideHref}" style="color: #5569dd; text-decoration: none;">step-by-step guide</a> for centers is available as a Word document.</p>
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
   * "needs center action", blue for in-negotiation.
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
   * Minimal HTML escape for values interpolated into the email body. Project
   * names / codes are admin- or import-curated, so the practical XSS risk is
   * low — but the body renders in someone's inbox, so we harden it anyway.
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
