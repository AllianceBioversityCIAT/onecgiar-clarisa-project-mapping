import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

/**
 * Feature module for user management.
 *
 * Registers the {@link User} entity with TypeORM and exposes
 * {@link UsersService} so other modules (e.g., Auth) can inject it.
 * The {@link UsersController} provides admin-only endpoints for
 * listing and updating user records.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
