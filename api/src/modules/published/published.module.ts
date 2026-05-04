import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PublishedSnapshot } from './entities/published-snapshot.entity';
import { PublishedProject } from './entities/published-project.entity';
import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { PublishedController } from './published.controller';
import { PublishedService } from './published.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PublishedSnapshot,
      PublishedProject,
      Project,
      ProjectMapping,
    ]),
    AuditModule,
  ],
  controllers: [PublishedController],
  providers: [PublishedService],
})
export class PublishedModule {}
