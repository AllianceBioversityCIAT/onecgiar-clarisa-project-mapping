import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ProjectMapping } from './entities/project-mapping.entity';
import { MappingNegotiation } from './entities/mapping-negotiation.entity';
import { ProjectNegotiationMessage } from './entities/project-negotiation-message.entity';
import { Project } from '../projects/entities/project.entity';
import { Program } from '../reference-data/entities/program.entity';
import { MappingsService } from './mappings.service';
import { MappingsController } from './mappings.controller';
import { NegotiationGateway } from './gateways/negotiation.gateway';
import { UsersModule } from '../users/users.module';

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
      Project,
      Program,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('auth.jwtSecret'),
      }),
    }),
    UsersModule,
  ],
  providers: [MappingsService, NegotiationGateway],
  controllers: [MappingsController],
  exports: [MappingsService],
})
export class MappingsModule {}
