import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';
import { RequestContextService } from '../context/request-context.service';

/**
 * Interceptor that logs the HTTP method, path, status code, and
 * response duration for every request.
 *
 * Uses the NestJS Logger (which routes through the Winston transport
 * configured in main.ts) so that all HTTP activity is captured in
 * the http-*.log rotate file.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly contextService: RequestContextService) {}

  /**
   * Intercept the request, measure execution time, and log the result.
   * @param context - The current execution context.
   * @param next - The next handler in the chain.
   * @returns An observable that logs on completion.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const { method, originalUrl } = request;
    const startTime = Date.now();

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - startTime;
        const statusCode = response.statusCode;
        const requestId = this.contextService.getRequestId() || '-';

        this.logger.log(
          `${method} ${originalUrl} ${statusCode} ${duration}ms [${requestId}]`,
        );
      }),
    );
  }
}
