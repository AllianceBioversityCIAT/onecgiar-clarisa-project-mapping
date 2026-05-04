import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';

/**
 * Global module that provides request-scoped context via AsyncLocalStorage.
 *
 * Registered globally so that any module can inject `RequestContextService`
 * without explicitly importing this module.
 *
 * The module also wires `RequestContextMiddleware` onto every route — that
 * middleware establishes the AsyncLocalStorage scope so that
 * `setRequestId()` and `setUserId()` actually persist values for the
 * lifetime of the request.
 */
@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class RequestContextModule implements NestModule {
  /**
   * Bind the request-context middleware to every incoming route. Using
   * `forRoutes('*')` means the middleware fires before any guard or
   * interceptor, which is required for AsyncLocalStorage to be active
   * throughout the entire request pipeline.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
