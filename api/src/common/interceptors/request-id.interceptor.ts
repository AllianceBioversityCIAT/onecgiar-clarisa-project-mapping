import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';
import { RequestContextService } from '../context/request-context.service';

/**
 * Interceptor that assigns a unique UUID to every incoming HTTP request.
 *
 * - If the client sends an `X-Request-ID` header, it is reused.
 * - Otherwise a new v4 UUID is generated.
 * - The ID is set on the response `X-Request-ID` header and stored in
 *   `RequestContextService` for downstream consumers (loggers, etc.).
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  constructor(private readonly contextService: RequestContextService) {}

  /**
   * Intercept the request to assign and propagate the request ID.
   * @param context - The current execution context.
   * @param next - The next handler in the chain.
   * @returns An observable that continues the request pipeline.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const requestId =
      (request.headers['x-request-id'] as string) || uuidv4();

    response.setHeader('X-Request-ID', requestId);
    this.contextService.setRequestId(requestId);

    return next.handle();
  }
}
