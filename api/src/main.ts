import { NestFactory, Reflector } from '@nestjs/core';
import {
  ClassSerializerInterceptor,
  ValidationPipe,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';
import { WinstonLogger } from './common/logger/winston.logger';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { RequestContextService } from './common/context/request-context.service';

/**
 * Bootstrap the NestJS application with all global infrastructure:
 * - Winston logger
 * - Global prefix, CORS, Helmet
 * - Validation pipe, exception filter, interceptors
 * - Swagger documentation (non-production)
 */
async function bootstrap(): Promise<void> {
  const winstonLogger = new WinstonLogger();

  const app = await NestFactory.create(AppModule, {
    logger: winstonLogger,
  });

  const configService = app.get(ConfigService);
  const requestContextService = app.get(RequestContextService);

  /** CORS configuration from environment (comma-separated origins supported). */
  const corsOrigin = configService.get<string>(
    'app.corsOrigin',
    'http://localhost:4200',
  );
  const origins = corsOrigin.split(',').map((o) => o.trim());
  app.enableCors({
    origin: origins.length === 1 ? origins[0] : origins,
    credentials: true,
  });

  /**
   * Explicit Socket.IO adapter binding. Without this, Nest auto-detects
   * an adapter from installed peer dependencies — which works in dev but
   * is fragile if a build ever ships with both `@nestjs/platform-ws` and
   * `@nestjs/platform-socket.io` resolved. Pinning to Socket.IO here
   * matches the client (`socket.io-client`).
   */
  app.useWebSocketAdapter(new IoAdapter(app));

  /** Security headers via Helmet. */
  app.use(helmet());

  /** Parse cookies (required for refresh token handling). */
  app.use(cookieParser());

  /**
   * Global validation pipe:
   * - whitelist: strips properties not in the DTO
   * - forbidNonWhitelisted: throws if unknown properties are sent
   * - transform: auto-transforms payloads to DTO class instances
   * - enableImplicitConversion: allows query param type coercion
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  /** Global exception filter — structured error responses. */
  app.useGlobalFilters(new AllExceptionsFilter());

  /**
   * Global interceptors:
   * - ClassSerializerInterceptor: honours @Exclude() decorators on entities
   * - RequestIdInterceptor: attaches X-Request-ID to every request
   * - LoggingInterceptor: structured HTTP request/response logging
   */
  app.useGlobalInterceptors(
    new ClassSerializerInterceptor(app.get(Reflector)),
    new RequestIdInterceptor(requestContextService),
    new LoggingInterceptor(requestContextService),
  );

  /**
   * Swagger / OpenAPI documentation.
   * Only enabled outside of production to avoid exposing internal API details.
   */
  const environment = configService.get<string>(
    'app.environment',
    'development',
  );
  if (environment !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('PRMS Projects Registry API')
      .setDescription('API for managing CGIAR PRMS research projects')
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT access token',
        },
        'access-token',
      )
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  /** Start listening. */
  const port = configService.get<number>('app.port', 3000);
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Application running on port ${port} [${environment}]`);
  logger.log(`Swagger docs available at http://localhost:${port}/docs`);
}

bootstrap();
