import { Global, Module } from '@nestjs/common';
import { RequestContextService } from './request-context.service';

/**
 * Global module that provides request-scoped context via AsyncLocalStorage.
 *
 * Registered globally so that any module can inject `RequestContextService`
 * without explicitly importing this module.
 */
@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class RequestContextModule {}
