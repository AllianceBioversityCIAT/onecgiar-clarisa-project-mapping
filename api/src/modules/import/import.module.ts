import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ImportService } from './import.service';
import { ImportController } from './import.controller';
import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Program } from '../reference-data/entities/program.entity';
import { Country } from '../reference-data/entities/country.entity';
import { User } from '../users/entities/user.entity';

/**
 * Module encapsulating CSV data import functionality.
 *
 * Provides an admin-only endpoint to import projects and their
 * program mappings from the TOC_Projects.csv file. Registers
 * repositories for all entities involved in the import process.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectMapping,
      Center,
      Program,
      Country,
      User,
    ]),
  ],
  providers: [ImportService],
  controllers: [ImportController],
})
export class ImportModule {}
