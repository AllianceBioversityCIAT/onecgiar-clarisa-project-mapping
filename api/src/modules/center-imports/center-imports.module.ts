import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';

import { CenterImportsService } from './center-imports.service';
import { CenterImportsController } from './center-imports.controller';

import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { MappingNegotiation } from '../mappings/entities/mapping-negotiation.entity';
import { Program } from '../reference-data/entities/program.entity';

/**
 * Module for center-rep bulk mappings import.
 *
 * Provides three endpoints:
 *  - GET  /center-imports/mappings/template — download pre-filled .xlsx
 *  - POST /center-imports/mappings/validate  — parse + validate + preview
 *  - POST /center-imports/mappings/commit    — execute the import
 *
 * Uses the same JWT secret as AuthModule so batchId tokens are signed
 * with the project's main secret. No new DB tables — all state lives
 * in an in-memory Map on the service (evicted after 35 min).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectMapping,
      MappingNegotiation,
      Program,
    ]),
    // Sign batchId tokens with the same secret used by AuthModule.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('auth.jwtSecret'),
        signOptions: { expiresIn: '30m' },
      }),
    }),
    // Store uploaded files in memory (no disk writes).
    MulterModule.register({ storage: undefined }),
  ],
  providers: [CenterImportsService],
  controllers: [CenterImportsController],
})
export class CenterImportsModule {}
