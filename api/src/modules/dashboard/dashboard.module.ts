import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Program } from '../reference-data/entities/program.entity';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

/**
 * Feature module for dashboard aggregation endpoints.
 *
 * Provides role-aware summary statistics, allocation status, and
 * recent activity feeds. All data is read-only and sourced from
 * the Projects and ProjectMappings tables via aggregate queries.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Project, ProjectMapping, Center, Program]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
