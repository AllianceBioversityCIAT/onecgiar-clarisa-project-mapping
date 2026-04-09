import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectMapping } from './entities/project-mapping.entity';
import { Project } from '../projects/entities/project.entity';
import { Program } from '../reference-data/entities/program.entity';
import { MappingsService } from './mappings.service';
import { MappingsController } from './mappings.controller';

/**
 * Feature module for project-to-program mappings.
 *
 * Handles the full mapping lifecycle including creation by program
 * representatives, allocation validation, and approval/rejection
 * by center representatives.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ProjectMapping, Project, Program])],
  providers: [MappingsService],
  controllers: [MappingsController],
  exports: [MappingsService],
})
export class MappingsModule {}
