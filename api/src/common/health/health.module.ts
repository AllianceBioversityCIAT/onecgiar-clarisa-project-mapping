import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * Module encapsulating the health-check endpoint.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
