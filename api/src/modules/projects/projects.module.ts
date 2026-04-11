import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from './entities/project.entity';
import { ProjectBudget } from './entities/project-budget.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Country } from '../reference-data/entities/country.entity';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

/**
 * Feature module encapsulating all project-related functionality.
 *
 * Registers the Project and ProjectBudget entity repositories along
 * with Center and Country repositories needed for relation resolution
 * during create/update operations.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Project, ProjectBudget, Center, Country]),
  ],
  providers: [ProjectsService],
  controllers: [ProjectsController],
  exports: [ProjectsService],
})
export class ProjectsModule {}
