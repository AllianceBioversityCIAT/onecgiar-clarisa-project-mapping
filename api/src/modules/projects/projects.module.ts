import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from './entities/project.entity';
import { ProjectBudget } from './entities/project-budget.entity';
import { ProjectAuditEvent } from './entities/project-audit-event.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Country } from '../reference-data/entities/country.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { MappingNegotiation } from '../mappings/entities/mapping-negotiation.entity';
import { ProjectNegotiationMessage } from '../mappings/entities/project-negotiation-message.entity';
import { ProjectsService } from './projects.service';
import { ProjectsExportService } from './services/projects-export.service';
import { ProjectsController } from './projects.controller';

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
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectBudget,
      ProjectAuditEvent,
      Center,
      Country,
      ProjectMapping,
      MappingNegotiation,
      ProjectNegotiationMessage,
    ]),
  ],
  providers: [ProjectsService, ProjectsExportService],
  controllers: [ProjectsController],
  exports: [ProjectsService],
})
export class ProjectsModule {}
