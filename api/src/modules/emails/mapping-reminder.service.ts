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
import { ProjectsService } from '../projects/projects.service';

/**
 * Template key written to `emails.template_key` for every row produced
 * by this service. Used by the idempotency check (same key + same
 * `metadata.reminderDate` + same recipient + same `metadata.centerId` =
 * duplicate, skip enqueue) and by future template-rendering layers.
 * Center scoping is required so a multi-center rep still receives one
 * reminder per center they represent.
 */
const TEMPLATE_KEY = 'center_mapping_reminder';

/**
 * Mapped-percentage threshold (inclusive) at which we stop sending
 * reminders to a center. Mirrors the "90 % target" surfaced by the
 * dashboard and the email body.
 */
const TARGET_MAPPED_PERCENT = 90;

/**
 * Outcome summary returned by {@link MappingReminderService.runTick}.
 *
 * Both the cron handler (which ignores it) and the admin "run now"
 * endpoint use the same tick; the endpoint surfaces this so an admin
 * can see exactly what a manual run produced — including the reason a
 * run generated nothing (e.g. the deadline is not set).
 */
export interface ReminderTickResult {
  /**
   * `true` when the tick reached the per-center loop. `false` when a
   * global gate short-circuited it (see {@link shortCircuit}) or the
   * tick threw.
   */
  ran: boolean;
  /** Total reminder rows enqueued across all centers this tick. */
  enqueued: number;
  /** Number of centers iterated (0 when a global gate fired first). */
  centersTotal: number;
  /** Centers that enqueued at least one reminder. */
  centersEnqueued: number;
  /**
   * Centers skipped by a stop condition (target met / no portfolio /
   * no recipients) or because every recipient was already reminded today.
   */
  centersSkipped: number;
  /**
   * Why the tick produced nothing, when applicable:
   *  - `deadline_disabled` — the mapping deadline is not enabled / not set
   *  - `deadline_passed`   — the deadline is already in the past
   *  - `weekly_cadence`    — non-Monday outside the 3-day window (cron
   *                          only; never returned for a `force` run)
   *  - `error`             — the tick threw; see {@link message}
   * `null` when the tick ran normally (even if 0 rows were enqueued for
   * benign reasons such as every center already being at the target).
   */
  shortCircuit:
    | 'deadline_disabled'
    | 'deadline_passed'
    | 'weekly_cadence'
    | 'error'
    | null;
  /** Human-readable one-line summary, safe to surface in the admin UI. */
  message: string;
}

/**
 * Cron worker that enqueues weekly / daily mapping-progress reminder
 * emails to every active `center_rep` user.
 *
 * Cadence (UTC):
 *  - `deadline_date - today > 3 days` → weekly; only proceed on Monday.
 *  - `deadline_date - today ≤ 3 days` → daily; proceed any weekday.
 *  - A manual/admin run (`runTick(now, { force: true })`) bypasses the
 *    weekly Monday throttle so reminders generate on demand; every other
 *    gate and the per-recipient idempotency guard still apply.
 *
 * Stop conditions (per center):
 *  - `system_settings.deadline_enabled = false`
 *  - deadline already passed (today ≥ deadline date)
 *  - center has reached `mappedPercent >= 90` (target met)
 *  - center has `totalBudgetYear === 0` (no portfolio to map)
 *  - center has no active `center_rep` recipients
 *
 * Idempotency:
 *  - Per (recipient, day, center): an `emails` row with `template_key =
 *    'center_mapping_reminder'`, `metadata.reminderDate = todayIso` and
 *    `metadata.centerId = center.id` must not already exist. Scoping by
 *    center lets a multi-center rep get one reminder per center per day.
 *    Implemented with a JSON_EXTRACT lookup
 *    against the existing `metadata` column — no schema change.
 *
 * This service is a **producer** only — it drops rows on the queue.
 * Actual delivery is the responsibility of `EmailsDispatchService`
 * (the cron that publishes queued rows to the CGIAR Notification
 * Microservice via RabbitMQ).
 *
 * The dispatcher (`EmailsDispatchService`) is the sole owner of the
 * `system_settings.email_enabled` kill switch. This service
 * deliberately ignores it so that reminder rows are always generated
 * on schedule. Rows queued during a kill-switch window will publish
 * automatically once `email_enabled` is re-enabled. This guarantees
 * no reminder is ever silently lost.
 */
@Injectable()
export class MappingReminderService {
  private readonly logger = new Logger(MappingReminderService.name);

  constructor(
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Center)
    private readonly centerRepository: Repository<Center>,
    private readonly settingsService: SettingsService,
    private readonly projectsService: ProjectsService,
    private readonly emailsService: EmailsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Cron entry point
  // ---------------------------------------------------------------------------

  /**
   * Daily cron at 09:00 UTC. The handler delegates to {@link runTick}
   * so e2e tests can drive the same logic without waiting for the
   * scheduler.
   */
  @Cron('0 9 * * *', { name: 'mapping-reminder' })
  async handleCron(): Promise<void> {
    // The result is intentionally ignored on the scheduled path — the
    // admin "run now" endpoint is the only caller that consumes it.
    await this.runTick();
  }

  // ---------------------------------------------------------------------------
  // Public tick — driven by the cron and by e2e tests
  // ---------------------------------------------------------------------------

  /**
   * Single tick of the reminder workflow. Public so the
   * `qa-test-engineer` e2e suite can call it directly and assert on
   * the resulting `emails` rows.
   *
   * The optional `now` parameter is for tests that need to pin the
   * "current" timestamp (e.g. simulate Tuesday with a 7-day deadline).
   * Production calls pass nothing and use `new Date()`.
   *
   * `options.force` (default `false`) bypasses the weekly Monday-only
   * throttle so an admin can generate reminders on demand. Every other
   * gate — deadline enabled/set/not-passed, per-center stop conditions,
   * and per-recipient/per-day idempotency — still applies.
   *
   * Returns a {@link ReminderTickResult} summary. Top-level try/catch
   * protects the cron handler — an unexpected error in one tick must not
   * abort `@nestjs/schedule` — and is folded into the returned summary
   * (`shortCircuit: 'error'`) so the admin endpoint can surface it.
   */
  async runTick(
    now: Date = new Date(),
    options: { force?: boolean } = {},
  ): Promise<ReminderTickResult> {
    const force = options.force ?? false;
    try {
      // ----- Step 1: global gates --------------------------------------------
      //
      // NOTE: `system_settings.email_enabled` is intentionally NOT read
      // here. The dispatcher (`EmailsDispatchService`) is the sole
      // owner of that kill switch — reminders must always be enqueued
      // on schedule so nothing is lost during a kill-switch window;
      // rows publish automatically once email sending is re-enabled.
      const settings = await this.settingsService.getSettings();

      if (!settings.deadlineEnabled || !settings.deadlineDate) {
        this.logger.log(
          'Mapping reminders skipped: deadline is not enabled or not set',
        );
        return this.emptyResult(
          'deadline_disabled',
          'No reminders generated: the mapping deadline is not enabled or not set.',
        );
      }

      // ----- Step 2: deadline math (UTC calendar-day diff) -------------------

      const todayIso = this.toIsoDate(now);
      const daysUntilDeadline = this.daysBetweenUtc(
        todayIso,
        settings.deadlineDate,
      );

      if (daysUntilDeadline < 0) {
        this.logger.log(
          `Mapping reminders skipped: deadline ${settings.deadlineDate} already passed`,
        );
        return this.emptyResult(
          'deadline_passed',
          `No reminders generated: the deadline (${settings.deadlineDate}) has already passed.`,
        );
      }

      // Weekly cadence: only run on Monday when the deadline is still
      // comfortably ahead. Switch to daily inside the 3-day window. A
      // forced (admin) run skips this throttle entirely.
      if (!force && daysUntilDeadline > 3 && now.getUTCDay() !== 1) {
        this.logger.debug(
          `Mapping reminders skipped: weekly cadence, today UTC weekday=${now.getUTCDay()} (Mon=1)`,
        );
        return this.emptyResult(
          'weekly_cadence',
          'No reminders generated: the weekly cadence only runs on Mondays until the final 3-day window. Use a manual run to send now.',
        );
      }

      // ----- Step 3: iterate centers (sequential, isolated) ------------------

      const centers = await this.centerRepository.find();
      this.logger.log(
        `Mapping reminders tick started${force ? ' (forced)' : ''}: today=${todayIso}, deadline=${settings.deadlineDate}, ` +
          `daysUntilDeadline=${daysUntilDeadline}, centers=${centers.length}`,
      );

      let totalEnqueued = 0;
      let centersEnqueued = 0;

      for (const center of centers) {
        try {
          const enqueued = await this.processCenter(
            center,
            settings.deadlineDate,
            todayIso,
          );
          totalEnqueued += enqueued;
          if (enqueued > 0) centersEnqueued += 1;
        } catch (err) {
          // One bad center must not abort the whole tick. The next
          // tick (tomorrow or next Monday) will retry.
          this.logger.error(
            `Failed to process center id=${center.id} (${center.acronym ?? center.name}): ${(err as Error).message}`,
            (err as Error).stack,
          );
        }
      }

      this.logger.log(
        `Mapping reminders tick complete: enqueued=${totalEnqueued} emails across ${centersEnqueued}/${centers.length} centers`,
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
            ? `Queued ${totalEnqueued} reminder${totalEnqueued === 1 ? '' : 's'} across ${centersEnqueued} of ${centers.length} center${centers.length === 1 ? '' : 's'}.`
            : 'No reminders queued: every center is already at the target, has no portfolio or recipients, or was already reminded today.',
      };
    } catch (err) {
      this.logger.error(
        `Mapping reminders tick failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return this.emptyResult(
        'error',
        `Reminder run failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Builds a zero-enqueue {@link ReminderTickResult} for a tick that
   * short-circuited at a global gate or threw before/at iteration.
   */
  private emptyResult(
    shortCircuit: ReminderTickResult['shortCircuit'],
    message: string,
  ): ReminderTickResult {
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
   * Processes a single center: computes its progress, applies the
   * stop conditions, resolves recipients, and enqueues one email per
   * recipient that has not already been reminded today.
   *
   * Returns the number of rows enqueued for this center (0 when any
   * stop condition fires or all recipients were already reminded).
   */
  private async processCenter(
    center: Center,
    deadlineDate: string,
    todayIso: string,
  ): Promise<number> {
    // Reuse the existing summary engine to compute mapping progress
    // for this center. Passing `centerId` on the query DTO scopes the
    // SQL to projects in this center; we deliberately do NOT pass a
    // mock `user` so role-based exclusion / showExcluded logic stays
    // in admin-mode (i.e. no exclusion filtering). The defaults for
    // `budgetYear` (FY26) inherit from the service.
    const summary = await this.projectsService.getSummary({
      centerId: center.id,
    });

    // Stop: no portfolio to map. Sending "you're 0 % of 0" is noise.
    if (summary.totalBudgetYear === 0) {
      this.logger.debug(
        `Center ${center.acronym} (id=${center.id}) skipped: no portfolio (totalBudgetYear=0)`,
      );
      return 0;
    }

    // Stop: target met. No further nudges once a center is at or
    // above 90 %.
    if (summary.mappedPercent >= TARGET_MAPPED_PERCENT) {
      this.logger.debug(
        `Center ${center.acronym} (id=${center.id}) skipped: target met ` +
          `(mappedPercent=${summary.mappedPercent} >= ${TARGET_MAPPED_PERCENT})`,
      );
      return 0;
    }

    // Recipients = every active center_rep belonging to this center
    // via `user_centers`. Multi-center reps receive ONE email per
    // center they belong to (handled here by re-evaluating per center).
    const recipients = await this.resolveRecipients(center.id);
    if (recipients.length === 0) {
      this.logger.debug(
        `Center ${center.acronym} (id=${center.id}) skipped: no active center_rep recipients`,
      );
      return 0;
    }

    // The body breaks the center's active projects into agreed /
    // in-negotiation / not-yet-mapped, mirroring the percentage block.
    // `getSummary` gives the budget %s but not the per-project counts, so
    // one extra cheap query splits the projects by mapping state.
    const { agreed: projectsAgreed, inNegotiation: projectsInNegotiation } =
      await this.countProjectsByMappingState(center.id);
    const projectsToMap = Math.max(
      summary.activeProjectCount - projectsAgreed - projectsInNegotiation,
      0,
    );

    const subject = this.buildSubject(center.acronym);
    const body = this.buildBody({
      centerName: center.name,
      mappedPercent: summary.mappedPercent,
      inNegotiationPercent: summary.inNegotiationPercent,
      projectsAgreed,
      projectsInNegotiation,
      projectsToMap,
      deadlineDate,
    });

    let enqueuedForCenter = 0;

    for (const recipient of recipients) {
      try {
        const alreadySent = await this.alreadyReminded(
          recipient.id,
          todayIso,
          center.id,
        );
        if (alreadySent) {
          this.logger.debug(
            `Recipient userId=${recipient.id} for center ${center.acronym} ` +
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
            centerId: center.id,
            mappedPercent: summary.mappedPercent,
            reminderDate: todayIso,
          },
        });

        enqueuedForCenter += 1;
      } catch (err) {
        // Per-recipient try/catch: one bad row must not abort the
        // remaining recipients for this center.
        this.logger.error(
          `Failed to enqueue mapping reminder for userId=${recipient.id} ` +
            `(center=${center.acronym}): ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }

    if (enqueuedForCenter > 0) {
      this.logger.log(
        `Center ${center.acronym} (id=${center.id}): enqueued ${enqueuedForCenter}/${recipients.length} reminder(s) ` +
          `(mappedPercent=${summary.mappedPercent}, projectsAgreed=${projectsAgreed}, projectsInNegotiation=${projectsInNegotiation}, projectsToMap=${projectsToMap})`,
      );
    }

    return enqueuedForCenter;
  }

  // ---------------------------------------------------------------------------
  // Recipients / idempotency / counts
  // ---------------------------------------------------------------------------

  /**
   * Returns every active `center_rep` user whose `user_centers`
   * membership includes `centerId`. The join uses the existing
   * `User.centers` ManyToMany relation, which materialises as a
   * SQL join through `user_centers`.
   *
   * camelCase property names per the CLAUDE.md TypeORM rule.
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
   * Returns true when an `emails` row already exists for this
   * recipient + today with our template key. Uses JSON_EXTRACT +
   * JSON_UNQUOTE so we don't need a new column or a new index — the
   * query is bounded by the existing `(to_user_id)` index, so even
   * scanning every row for a given recipient is cheap.
   */
  private async alreadyReminded(
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
        `JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.reminderDate')) = :today`,
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

  /**
   * Per-center project counts split by how far the center has taken each
   * active project's mapping, so the email can mirror the agreed /
   * in-negotiation / remaining percentage breakdown. The buckets are
   * mutually exclusive (each active project counts once, by its furthest-
   * along mapping state):
   *  - `agreed`        — has ≥1 `agreed` mapping (locked or ready to lock).
   *  - `inNegotiation` — has ≥1 `negotiating` mapping AND no `agreed` one
   *                      (actively negotiating, not yet committed).
   * The "not yet mapped" remainder is `activeProjectCount - agreed -
   * inNegotiation`, computed by the caller. This fixes the old
   * "1 project mapped" figure that ignored everything still in negotiation.
   *
   * One parameterised query against `project_mappings`; O(rows in this
   * center) and run at most once per center per day.
   */
  private async countProjectsByMappingState(
    centerId: number,
  ): Promise<{ agreed: number; inNegotiation: number }> {
    const result = await this.emailRepository.manager
      .createQueryBuilder()
      .select(
        "COUNT(DISTINCT CASE WHEN pm.status = 'agreed' THEN p.id END)",
        'agreed',
      )
      .addSelect(
        `COUNT(DISTINCT CASE
            WHEN pm.status = 'negotiating'
             AND NOT EXISTS (
               SELECT 1 FROM project_mappings a
               WHERE a.project_id = p.id AND a.status = 'agreed'
             )
            THEN p.id END)`,
        'inNegotiation',
      )
      .from('projects', 'p')
      .innerJoin(
        'project_mappings',
        'pm',
        "pm.project_id = p.id AND pm.status IN ('agreed', 'negotiating')",
      )
      .where('p.center_id = :centerId', { centerId })
      .andWhere("p.status = 'active'")
      .getRawOne<{
        agreed: string | number | null;
        inNegotiation: string | number | null;
      }>();

    const toInt = (v: string | number | null | undefined): number => {
      const n = typeof v === 'number' ? v : parseInt(String(v ?? '0'), 10);
      return Number.isFinite(n) ? n : 0;
    };

    return {
      agreed: toInt(result?.agreed),
      inNegotiation: toInt(result?.inNegotiation),
    };
  }

  // ---------------------------------------------------------------------------
  // Subject / body assembly
  // ---------------------------------------------------------------------------

  /**
   * Subject line. Uses the center's **acronym** so the recipient sees
   * "CGIAR Project Mapping Update – CIAT" at a glance — long names
   * waste subject-line real estate in mobile clients.
   */
  private buildSubject(centerAcronym: string): string {
    return `CGIAR Project Mapping Update – ${centerAcronym}`;
  }

  /**
   * Renders the HTML body. Inline styles only — webmail clients
   * routinely strip `<style>` blocks. 600 px container, sans-serif,
   * mirrors the visual language of `EmailsService.buildTestEmailBody`.
   *
   * All interpolated values are HTML-escaped via {@link escapeHtml}.
   * The deadline date is formatted as `DD Month YYYY` (e.g.
   * `12 June 2026`) using a small inline `toLocaleDateString` helper
   * — CLAUDE.md §2 forbids adding date-fns / moment for a 3-line
   * helper.
   */
  private buildBody(args: {
    centerName: string;
    mappedPercent: number;
    inNegotiationPercent: number;
    projectsAgreed: number;
    projectsInNegotiation: number;
    projectsToMap: number;
    deadlineDate: string;
  }): string {
    const centerName = this.escapeHtml(args.centerName);
    const mappedPercent = this.escapeHtml(
      this.formatPercent(args.mappedPercent),
    );
    const inNegotiationPercent = this.escapeHtml(
      this.formatPercent(args.inNegotiationPercent),
    );
    // Agreed + in-negotiation, capped at 100 so rounding can't show >100%.
    const totalMappedPercent = this.escapeHtml(
      this.formatPercent(
        Math.min(100, args.mappedPercent + args.inNegotiationPercent),
      ),
    );
    const projectsAgreed = this.escapeHtml(String(args.projectsAgreed));
    const projectsInNegotiation = this.escapeHtml(
      String(args.projectsInNegotiation),
    );
    const projectsToMap = this.escapeHtml(String(args.projectsToMap));
    const deadlineFormatted = this.escapeHtml(
      this.formatLongDate(args.deadlineDate),
    );

    const toolUrl = 'https://project-mapping.cgiar.org/';
    const guideUrl =
      'https://sites.google.com/cgxchange.org/cgiarprhub/w3bilatproject-mapping?authuser=0';
    // "Quick guide for Centers" Word document on CGIAR SharePoint. Rendered
    // as clickable text — the raw URL is long and full of query params, so
    // it is never shown verbatim. escapeHtml() encodes the '&' query
    // separators so the href stays valid HTML.
    const quickGuideUrl =
      'https://cgiar-my.sharepoint.com/:w:/r/personal/v_decol_cgiar_org/Documents/CGIAR%20Project%20Mapping%20Tool/CGIAR%20Project%20Registry%20%26%20Mapping%20Tool_Quick%20guide%20for%20Centers_V2.docx?d=wb1bc8df5e8514b229d44157db87db332&csf=1&web=1&e=f1auPn';
    const quickGuideHref = this.escapeHtml(quickGuideUrl);
    const supportEmail = 'PRMSTechSupport@cgiar.org';

    return `<!DOCTYPE html>
<html><body style="margin: 0; padding: 0; background: #faf9f9;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #faf9f9; padding: 16px 0;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background: #ffffff; border: 1px solid #e5e5e5; border-radius: 6px; font-family: Arial, Helvetica, sans-serif; color: #333; line-height: 1.5;">
      <tr><td style="padding: 24px 24px 8px 24px;">
        <h2 style="margin: 0 0 8px 0; color: #5569dd; font-size: 20px;">CGIAR Project Mapping Update</h2>
        <p style="margin: 0; color: #777; font-size: 13px;">FY2026 CGIAR Project Registry &amp; Mapping Tool</p>
      </td></tr>

      <tr><td style="padding: 16px 24px 0 24px;">
        <p style="margin: 0 0 12px 0;">Dear ${centerName} team,</p>
        <p style="margin: 0 0 16px 0;">Here is your mapping progress update for the FY2026 CGIAR Project Registry &amp; Mapping Tool.</p>
      </td></tr>

      <tr><td style="padding: 0 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background: #faf9f9; border: 1px solid #e5e5e5; border-radius: 4px;">
          <tr><td style="padding: 16px;">
            <p style="margin: 0 0 4px 0; font-size: 13px; color: #777;">Progress toward the 90% target of the 2026 budget</p>
            <p style="margin: 0 0 2px 0; font-size: 18px; color: #2e7d32;"><strong>${mappedPercent}% agreed</strong> <span style="color: #777; font-size: 13px;">(locked or ready to lock)</span></p>
            <p style="margin: 0 0 6px 0; font-size: 16px; color: #b26a00;"><strong>${inNegotiationPercent}% in negotiation</strong> <span style="color: #777; font-size: 13px;">(not yet agreed)</span></p>
            <p style="margin: 0; padding-top: 8px; border-top: 1px solid #e5e5e5; font-size: 16px; color: #5569dd;"><strong>${totalMappedPercent}% total mapped</strong></p>
            <ul style="margin: 12px 0 0 0; padding-left: 20px;">
              <li style="margin-bottom: 4px;"><strong>${projectsAgreed}</strong> projects agreed (locked or ready to lock)</li>
              <li style="margin-bottom: 4px;"><strong>${projectsInNegotiation}</strong> projects in negotiation</li>
              <li><strong>${projectsToMap}</strong> projects not yet mapped</li>
            </ul>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding: 16px 24px 0 24px;">
        <p style="margin: 0 0 6px 0;"><strong>Access the tool:</strong> <a href="${toolUrl}" style="color: #5569dd; text-decoration: none;">${toolUrl}</a></p>
        <p style="margin: 0 0 16px 0;"><strong>Center Mapping deadline:</strong> ${deadlineFormatted}</p>
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

  // ---------------------------------------------------------------------------
  // Formatting helpers (no external utility packages — CLAUDE.md §2)
  // ---------------------------------------------------------------------------

  /**
   * Returns today's UTC calendar day as a `YYYY-MM-DD` string. We use
   * UTC accessors so the cron — which runs on a server with arbitrary
   * timezone — produces a stable day boundary that matches the
   * `metadata.reminderDate` written on the row.
   */
  private toIsoDate(date: Date): string {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * Calendar-day diff between two `YYYY-MM-DD` strings, computed in
   * UTC so DST shifts don't add or drop a day at the boundary.
   * Positive when `toIso` is after `fromIso`.
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
   * Formats a `YYYY-MM-DD` date as `DD Month YYYY` (e.g.
   * `12 June 2026`) using `toLocaleDateString('en-GB', ...)`. Inline
   * to avoid pulling in date-fns / moment for a one-line helper.
   */
  private formatLongDate(yyyyMmDd: string): string {
    // Build at UTC midnight to avoid timezone shifts pulling the day
    // back to the previous date in negative offsets.
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

  /**
   * Returns the percentage rounded to one decimal place, stripping a
   * trailing `.0` so "47.0" reads as "47" in the email body.
   */
  private formatPercent(value: number): string {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  /**
   * Minimal HTML escape for values we interpolate into the email
   * body. Names come from `centers.name` / `centers.acronym` (admin /
   * CLARISA-curated) and counts are numeric, so the practical XSS
   * risk is low — but the body renders in someone's inbox, so we
   * harden it anyway.
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
