import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Email } from './entities/email.entity';
import { EmailsService } from './emails.service';
import { EmailsController } from './emails.controller';
import { EmailsDispatchService } from './emails-dispatch.service';
import { User } from '../users/entities/user.entity';
import { SettingsModule } from '../settings/settings.module';

/**
 * Feature module encapsulating the admin **Email Management** module.
 *
 * Surface:
 *  - REST controller mounted at `/admin/emails` (list / detail / retry).
 *  - `EmailsService` exported so future feature modules can inject it
 *    and call `enqueue()` to drop a row on the queue. There is
 *    intentionally no HTTP endpoint to enqueue from the outside.
 *
 * Repositories registered:
 *  - `Email` — the queue table.
 *  - `User`  — recipient lookups for the test-send endpoint
 *    (`POST /admin/emails/test-send`). The list/detail queries get the
 *    `User` recipient/enqueuer relations through `Email`'s metadata via
 *    the global connection and don't strictly need the User repo
 *    registered here, but `EmailsService.sendTest()` does a direct
 *    `findOne` against `users` so we register it for that.
 *
 * Cron dispatcher:
 *  - `EmailsDispatchService` is registered as a provider so its
 *    `@Cron`-decorated method is wired by `@nestjs/schedule` at app
 *    boot. It is intentionally **not** exported — nothing outside
 *    this module should call into it directly; the only contract is
 *    the queue table itself plus `EmailsService.enqueue()`.
 *
 * Out of scope for this slice (each is a separate follow-up):
 *  - Email provider integration beyond the existing
 *    NotificationsService (SES / SendGrid / SMTP).
 *  - Template rendering layer.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Email, User]), SettingsModule],
  providers: [EmailsService, EmailsDispatchService],
  controllers: [EmailsController],
  exports: [EmailsService],
})
export class EmailsModule {}
