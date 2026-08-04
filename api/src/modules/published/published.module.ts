import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PublishedSnapshot } from './entities/published-snapshot.entity';
import { PublishedProject } from './entities/published-project.entity';
import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { PublishedController } from './published.controller';
import { PublishedService } from './published.service';
import { AuditModule } from '../audit/audit.module';
import { MappingsModule } from '../mappings/mappings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PublishedSnapshot,
      PublishedProject,
      Project,
      ProjectMapping,
    ]),
    AuditModule,
    /* For MappingsService.hydrateTocLinksForMappings() — the snapshot
     * reuses the same batched polymorphic TOC resolver the negotiation
     * page uses rather than reimplementing the link_type fan-out. */
    MappingsModule,
  ],
  controllers: [PublishedController],
  providers: [PublishedService],
})
export class PublishedModule {}
