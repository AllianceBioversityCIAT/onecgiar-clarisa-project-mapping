import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Email } from './entities/email.entity';
import { EmailsService } from './emails.service';
import { EmailsController } from './emails.controller';
import { EmailsDispatchService } from './emails-dispatch.service';
import { MappingReminderService } from './mapping-reminder.service';
import { User } from '../users/entities/user.entity';
import { Center } from '../reference-data/entities/center.entity';
import { SettingsModule } from '../settings/settings.module';
import { ProjectsModule } from '../projects/projects.module';

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
  imports: [
    // `Center` is registered here (not via a forFeature in another
    // module) because `MappingReminderService` needs a `Repository<Center>`
    // to iterate centers on every cron tick. `user_centers` is the
    // implicit junction table created by `User.centers` (@JoinTable);
    // it does not have a dedicated entity class so it is not listed
    // here — the membership query uses `.innerJoin('user.centers', ...)`
    // which materialises the join through that table.
    TypeOrmModule.forFeature([Email, User, Center]),
    SettingsModule,
    // ProjectsModule exports ProjectsService so MappingReminderService
    // can reuse `getSummary({ centerId })` instead of duplicating the
    // KPI math.
    ProjectsModule,
  ],
  providers: [EmailsService, EmailsDispatchService, MappingReminderService],
  controllers: [EmailsController],
  // MappingReminderService is intentionally NOT exported — nothing
  // outside this module should be able to call it directly. The only
  // public contract is the cron schedule.
  exports: [EmailsService],
})
export class EmailsModule {}
