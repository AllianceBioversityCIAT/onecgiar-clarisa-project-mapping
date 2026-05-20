import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Center } from './entities/center.entity';
import { Program } from './entities/program.entity';
import { Country } from './entities/country.entity';
import { ActionArea } from './entities/action-area.entity';
import { TocAow } from './entities/toc-aow.entity';
import { TocOutcome } from './entities/toc-outcome.entity';
import { TocOutput } from './entities/toc-output.entity';
import { ReferenceDataService } from './reference-data.service';
import { ReferenceDataController } from './reference-data.controller';
import { TocSyncService } from './toc-sync.service';
import { AuditModule } from '../audit/audit.module';

/**
 * Module for CLARISA-synced reference data (centers, programs,
 * countries, action areas) and TOC-synced graph data (AOWs,
 * outcomes, outputs).
 *
 * Provides the sync services, REST endpoints, and TypeORM
 * repository registrations for every reference entity. The TOC
 * HTTP client is provided by the global {@link TocModule}, so
 * no explicit import is needed here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Center,
      Program,
      Country,
      ActionArea,
      TocAow,
      TocOutcome,
      TocOutput,
    ]),
    AuditModule,
  ],
  controllers: [ReferenceDataController],
  providers: [ReferenceDataService, TocSyncService],
  exports: [ReferenceDataService, TocSyncService],
})
export class ReferenceDataModule {}
