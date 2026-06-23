import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { EmailsService } from './emails.service';
import {
  MappingReminderService,
  ReminderTickResult,
} from './mapping-reminder.service';
import {
  ProgramMappingReminderService,
  ProgramReminderTickResult,
} from './program-mapping-reminder.service';
import { ListEmailsQueryDto } from './dto/list-emails.query.dto';
import { EmailDetailDto } from './dto/email-detail.dto';
import { EmailListItemDto } from './dto/email-list-item.dto';
import { SendTestEmailDto } from './dto/send-test-email.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

/**
 * REST controller for the admin **Email Management** module.
 *
 * Mount point is `/admin/emails` to match the pattern used by other
 * admin-only routes (e.g. `POST /admin/sync-clarisa`,
 * `POST /admin/import-csv`).
 *
 * All endpoints are admin-only via `@Roles(UserRole.ADMIN)` on top of
 * the global JWT auth guard. The global `RolesGuard` enforces this.
 *
 * Endpoints:
 *  - `GET    /admin/emails`            → paginated list
 *  - `GET    /admin/emails/:id`        → per-row detail (includes body + lastError)
 *  - `POST   /admin/emails/:id/retry`  → admin re-queues a `failed` row
 *  - `POST   /admin/emails/test-send`  → admin enqueues a fixed test
 *                                        email to verify the pipeline
 *  - `POST   /admin/emails/run-reminders` → admin runs the mapping-reminder
 *                                        generation now (force, on demand)
 *  - `DELETE /admin/emails/queued`     → admin hard-deletes every row
 *                                        currently in `queued` status
 *
 * There is intentionally **no `POST /admin/emails`** — emails are
 * enqueued internally by feature modules calling `EmailsService.enqueue()`.
 * An admin manually composing and sending arbitrary email is outside
 * the scope of this module. The `test-send` endpoint is the one
 * exception: it uses a **fixed server-side template** (admin only
 * picks the recipient), so it cannot be abused as an arbitrary
 * send-email surface.
 */
@ApiTags('admin / emails')
@ApiBearerAuth('access-token')
@Controller('admin/emails')
@Roles(UserRole.ADMIN)
export class EmailsController {
  private readonly logger = new Logger(EmailsController.name);

  constructor(
    private readonly emailsService: EmailsService,
    private readonly mappingReminderService: MappingReminderService,
    private readonly programMappingReminderService: ProgramMappingReminderService,
  ) {}

  /**
   * Paginated list of queue rows. Filters: status, recipient user,
   * free-text search (subject + to_email), queued-at date range.
   * Sort: `queued_at` / `sent_at` / `status` / `attempts`, ASC/DESC.
   */
  @Get()
  @ApiOperation({ summary: 'List queued/sent emails (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list',
  })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async list(@Query() query: ListEmailsQueryDto): Promise<{
    data: EmailListItemDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.emailsService.list(query);
  }

  /**
   * Full row detail. Includes the body, last error, lease state, and
   * provenance. 404 when the id is unknown.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get full detail for one email (admin only)' })
  @ApiResponse({ status: 200, description: 'Email detail' })
  @ApiResponse({ status: 404, description: 'Email not found' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<EmailDetailDto> {
    return this.emailsService.findOne(id);
  }

  /**
   * Re-queue a `failed` row. 400 (`EMAIL_NOT_RETRIABLE`) when the
   * row is not in `failed` status. Does NOT reset `attempts` — see
   * the service-level docstring for the rationale.
   *
   * The actor's user id is recorded in the structured log line so we
   * have an audit of which admin issued the retry.
   */
  @Post(':id/retry')
  @ApiOperation({
    summary:
      'Re-queue a failed email for another delivery attempt (admin only)',
  })
  @ApiResponse({ status: 200, description: 'Email re-queued' })
  @ApiResponse({
    status: 400,
    description: 'Email is not in failed status (code: EMAIL_NOT_RETRIABLE)',
  })
  @ApiResponse({ status: 404, description: 'Email not found' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async retry(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ): Promise<EmailDetailDto> {
    return this.emailsService.retry(id, user.id);
  }

  /**
   * Hard-deletes every row currently in `status = 'queued'`. Rows in
   * `sending`, `sent`, or `failed` are never touched. Returns the
   * exact count of rows removed.
   *
   * Idempotent — an empty queue returns `{ deleted: 0 }` with 200.
   *
   * The actor's user id is recorded in the structured Winston log
   * line so we have an audit of which admin issued the purge. The
   * matching id list is also logged (truncated at 50 ids).
   *
   * The route is declared as `DELETE /admin/emails/queued`. It is
   * placed BEFORE the dynamic `:id` parameterised routes in the file
   * so Nest's path-matching does not interpret `queued` as an id;
   * `@Delete('queued')` literal segment matching is unambiguous here
   * because the only DELETE on this controller is this one.
   */
  @Delete('queued')
  @ApiOperation({
    summary: 'Hard-delete every queued email (admin only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Queued rows purged; returns `{ deleted: N }`',
  })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async purgeQueued(@CurrentUser() user: User): Promise<{ deleted: number }> {
    return this.emailsService.purgeQueued(user.id);
  }

  /**
   * Enqueues a fixed-template test email so an admin can verify the
   * pipeline end-to-end without composing content.
   *
   * Bypasses the global `system_settings.email_enabled` toggle by
   * design — the whole point of this endpoint is to verify the
   * pipeline even when notifications are globally disabled. See
   * `EmailsService.sendTest()` for the rationale.
   *
   * Returns a minimal projection (not the full detail DTO) — the
   * caller only needs to know the row was queued and to which address.
   */
  @Post('test-send')
  @ApiOperation({
    summary:
      'Enqueue a fixed-template test email to a chosen user (admin only)',
  })
  @ApiResponse({
    status: 200,
    description: 'Test email enqueued',
  })
  @ApiResponse({
    status: 400,
    description: 'toUserId missing/invalid or recipient has no email',
  })
  @ApiResponse({ status: 404, description: 'Recipient user not found' })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async sendTest(
    @Body() dto: SendTestEmailDto,
    @CurrentUser() user: User,
  ): Promise<{
    id: number;
    toUserId: number;
    toEmail: string;
    subject: string;
    status: 'queued';
  }> {
    return this.emailsService.sendTest(dto.toUserId, user.id);
  }

  /**
   * Runs the mapping-reminder generation **now**, on demand, instead of
   * waiting for the daily 09:00 UTC cron. This is the admin "send the
   * reminders now" action.
   *
   * Runs in **force** mode: it bypasses the weekly-cadence throttle (the
   * cron only enqueues on Mondays until the final 3-day window) so the
   * run always attempts to generate reminders. Every other gate still
   * applies — the mapping deadline must be enabled, set, and not yet
   * passed; each center's stop conditions (no portfolio, already at the
   * target %, no active recipients) are honoured; and the per-recipient,
   * per-day idempotency guard prevents double-reminding anyone who
   * already received today's email (including from the cron).
   *
   * Like the cron, this enqueues rows regardless of
   * `system_settings.email_enabled` — that toggle gates the dispatcher,
   * not generation. The returned summary reports what happened so the
   * admin understands when a run produced nothing (e.g. deadline not set).
   *
   * The actor's user id is recorded in the structured Winston log line
   * so there is an audit of which admin triggered the run.
   */
  @Post('run-reminders')
  @ApiOperation({
    summary: 'Run the mapping-reminder generation now (admin only)',
  })
  @ApiResponse({
    status: 201,
    description: 'Reminder run completed; returns a summary of what happened',
  })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async runReminders(@CurrentUser() user: User): Promise<ReminderTickResult> {
    this.logger.log(
      `Manual mapping-reminder run triggered by userId=${user.id}`,
    );
    return this.mappingReminderService.runTick(new Date(), { force: true });
  }

  /**
   * Runs the **program** mapping-reminder generation now, on demand, instead
   * of waiting for the daily 09:05 UTC cron. Sends the program-start email to
   * active `program_rep` users whose programs still have mappings awaiting a
   * response.
   *
   * The program reminder runs on a daily cadence (no weekly throttle), so
   * there is no force flag — the manual run is identical to the cron path.
   * Every gate still applies: the program deadline must be enabled, set, and
   * not yet passed; each program's stop conditions (no pending mappings, no
   * active recipients) are honoured; and the per-recipient/per-day
   * idempotency guard prevents double-reminding anyone reminded today.
   *
   * Like the cron, this enqueues rows regardless of
   * `system_settings.email_enabled` — that toggle gates the dispatcher, not
   * generation.
   */
  @Post('run-program-reminders')
  @ApiOperation({
    summary: 'Run the program mapping-reminder generation now (admin only)',
  })
  @ApiResponse({
    status: 201,
    description: 'Reminder run completed; returns a summary of what happened',
  })
  @ApiResponse({ status: 403, description: 'Forbidden — requires admin role' })
  async runProgramReminders(
    @CurrentUser() user: User,
  ): Promise<ProgramReminderTickResult> {
    this.logger.log(
      `Manual program mapping-reminder run triggered by userId=${user.id}`,
    );
    return this.programMappingReminderService.runTick(new Date());
  }
}
