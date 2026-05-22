import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from './entities/project.entity';
import { ProjectBudget } from './entities/project-budget.entity';
import { ProjectExclusion } from './entities/project-exclusion.entity';
import { ProjectBenefitCountry } from './entities/project-benefit-country.entity';
import { ProjectImplementationCountry } from './entities/project-implementation-country.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Country } from '../reference-data/entities/country.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { MappingNegotiation } from '../mappings/entities/mapping-negotiation.entity';
import { ProjectNegotiationMessage } from '../mappings/entities/project-negotiation-message.entity';
import { ProjectsService } from './projects.service';
import { ProjectsExportService } from './services/projects-export.service';
import { ProjectExclusionService } from './services/project-exclusion.service';
import { ProjectsController } from './projects.controller';
import { AuditModule } from '../audit/audit.module';

/**
 * Feature module encapsulating all project-related functionality.
 *
 * Registers the Project and ProjectBudget entity repositories along
 * with Center and Country repositories needed for relation resolution
 * during create/update operations.
 *
 * Also registers ProjectMapping, MappingNegotiation, and
 * ProjectNegotiationMessage so the ProjectsExportService can load
 * related negotiation data for detail exports without coupling the
 * export feature to the MappingsModule.
 *
 * AuditModule is imported so ProjectsService and ProjectsExportService
 * can record audit events and read the per-project audit history
 * through AuditService.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectBudget,
      ProjectExclusion,
      ProjectBenefitCountry,
      ProjectImplementationCountry,
      Center,
      Country,
      ProjectMapping,
      MappingNegotiation,
      ProjectNegotiationMessage,
    ]),
    AuditModule,
  ],
  providers: [ProjectsService, ProjectsExportService, ProjectExclusionService],
  controllers: [ProjectsController],
  exports: [ProjectsService, ProjectExclusionService],
})
export class ProjectsModule {}
