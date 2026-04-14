import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectMapping } from './entities/project-mapping.entity';
import { MappingNegotiation } from './entities/mapping-negotiation.entity';
import { Project } from '../projects/entities/project.entity';
import { Program } from '../reference-data/entities/program.entity';
import { MappingsService } from './mappings.service';
import { MappingsController } from './mappings.controller';

/**
 * Feature module for project-to-program mappings.
 *
 * Handles the full negotiation lifecycle: initiation by center
 * representatives, counter-proposals, agreement tracking, and
 * project round locking.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectMapping,
      MappingNegotiation,
      Project,
      Program,
    ]),
  ],
  providers: [MappingsService],
  controllers: [MappingsController],
  exports: [MappingsService],
})
export class MappingsModule {}
