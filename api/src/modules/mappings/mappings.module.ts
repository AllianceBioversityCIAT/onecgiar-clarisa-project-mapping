import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ProjectMapping } from './entities/project-mapping.entity';
import { MappingNegotiation } from './entities/mapping-negotiation.entity';
import { ProjectNegotiationMessage } from './entities/project-negotiation-message.entity';
import { MappingTocLink } from './entities/mapping-toc-link.entity';
import { Project } from '../projects/entities/project.entity';
import { Program } from '../reference-data/entities/program.entity';
import { TocAow } from '../reference-data/entities/toc-aow.entity';
import { TocOutput } from '../reference-data/entities/toc-output.entity';
import { TocOutcome } from '../reference-data/entities/toc-outcome.entity';
import { MappingsService } from './mappings.service';
import { MappingsController } from './mappings.controller';
import { NegotiationGateway } from './gateways/negotiation.gateway';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';

/**
 * Feature module for project-to-program mappings.
 *
 * Handles the full negotiation lifecycle: initiation by center
 * representatives, counter-proposals, agreement tracking, and
 * project round locking. Also hosts the {@link NegotiationGateway}
 * which fans out realtime updates to subscribed clients.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProjectMapping,
      MappingNegotiation,
      ProjectNegotiationMessage,
      MappingTocLink,
      Project,
      Program,
      TocAow,
      TocOutput,
      TocOutcome,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('auth.jwtSecret'),
      }),
    }),
    UsersModule,
    AuditModule,
  ],
  providers: [MappingsService, NegotiationGateway],
  controllers: [MappingsController],
  exports: [MappingsService],
})
export class MappingsModule {}
