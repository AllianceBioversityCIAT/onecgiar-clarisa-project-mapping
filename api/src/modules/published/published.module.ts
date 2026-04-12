import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PublishedSnapshot } from './entities/published-snapshot.entity';
import { PublishedProject } from './entities/published-project.entity';
import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { PublishedController } from './published.controller';
import { PublishedService } from './published.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PublishedSnapshot,
      PublishedProject,
      Project,
      ProjectMapping,
    ]),
  ],
  controllers: [PublishedController],
  providers: [PublishedService],
})
export class PublishedModule {}
