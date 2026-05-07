import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEvent } from './entities/audit-event.entity';
import { User } from '../users/entities/user.entity';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

/**
 * Provides the unified audit log service.
 *
 * Exports `AuditService` so any feature module can record events via DI:
 *
 *   constructor(private readonly auditService: AuditService) {}
 *
 * `RequestContextService` is consumed by the service via the global
 * `RequestContextModule` (registered with `@Global()` in app.module),
 * so we don't import it explicitly here.
 *
 * The User repository is registered too because `AuditService.record()`
 * needs to look up the actor for denormalisation when no override is
 * supplied. The User entity itself is owned by UsersModule — registering
 * its repository in this module is a TypeORM-supported pattern that
 * doesn't conflict with the primary registration.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuditEvent, User])],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
