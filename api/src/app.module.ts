import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import authConfig from './config/auth.config';
import clarisaConfig from './config/clarisa.config';
import { RequestContextModule } from './common/context/request-context.module';
import { HealthModule } from './common/health/health.module';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { ClarisaModule } from './modules/clarisa/clarisa.module';
import { ReferenceDataModule } from './modules/reference-data/reference-data.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { MappingsModule } from './modules/mappings/mappings.module';
import { ImportModule } from './modules/import/import.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';

/**
 * Root application module.
 *
 * Imports global configuration, database connectivity, request-context
 * tracking, and the health-check endpoint. Feature modules are added
 * here as they are implemented.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, authConfig, clarisaConfig],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql',
        host: configService.get('database.host'),
        port: configService.get('database.port'),
        username: configService.get('database.username'),
        password: configService.get('database.password'),
        database: configService.get('database.database'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
        synchronize: false,
        charset: 'utf8mb4',
        logging: configService.get('app.environment') === 'development',
      }),
    }),
    /**
     * Rate-limiting configuration. Not applied globally — the ThrottlerGuard
     * is selectively used on auth endpoints to prevent brute-force attacks.
     */
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 10,
    }]),
    RequestContextModule,
    HealthModule,
    UsersModule,
    AuthModule,
    ClarisaModule,
    ReferenceDataModule,
    ProjectsModule,
    MappingsModule,
    ImportModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    /** Global JWT authentication guard — all routes require a valid token unless marked @Public(). */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    /** Global role-based authorization guard — enforced after JWT validation. */
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
