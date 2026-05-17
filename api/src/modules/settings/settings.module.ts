import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemSettings } from './entities/system-settings.entity';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

/**
 * Feature module encapsulating the application-wide System Settings
 * managed by the admin Settings page.
 *
 * Registers the singleton `SystemSettings` repository, the service
 * that operates on it, and the REST controller mounted at `/settings`.
 *
 * Exports `SettingsService` so other modules (e.g. a future email
 * module or mapping-deadline enforcer) can read the flags without
 * having to register their own repository.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SystemSettings])],
  providers: [SettingsService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
