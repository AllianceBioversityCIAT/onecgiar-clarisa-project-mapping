import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { Program } from '../reference-data/entities/program.entity';
import { Center } from '../reference-data/entities/center.entity';
import { AuditModule } from '../audit/audit.module';

/**
 * Feature module for user management.
 *
 * Registers the {@link User} entity with TypeORM and exposes
 * {@link UsersService} so other modules (e.g., Auth) can inject it.
 * The {@link UsersController} provides admin-only endpoints for
 * listing, creating, updating, and soft-deleting user records.
 *
 * `Program` and `Center` repositories are also registered (read-only
 * from this module's perspective) so `UsersService.createUser` can
 * verify referenced program/center ids exist before inserting the
 * user row — avoiding a noisy FK-violation error from the database.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, Program, Center]), AuditModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
