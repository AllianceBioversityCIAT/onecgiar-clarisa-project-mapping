import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Center } from './entities/center.entity';
import { Program } from './entities/program.entity';
import { Country } from './entities/country.entity';
import { ActionArea } from './entities/action-area.entity';
import { ReferenceDataService } from './reference-data.service';
import { ReferenceDataController } from './reference-data.controller';
import { AuditModule } from '../audit/audit.module';

/**
 * Module for CLARISA-synced reference data (centers, programs,
 * countries, action areas).
 *
 * Provides the sync service, REST endpoints, and TypeORM
 * repository registrations for all four reference entities.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Center, Program, Country, ActionArea]),
    AuditModule,
  ],
  controllers: [ReferenceDataController],
  providers: [ReferenceDataService],
  exports: [ReferenceDataService],
})
export class ReferenceDataModule {}
