import { inject } from '@angular/core';
import {
  HttpInterceptorFn,
  HttpRequest,
  HttpHandlerFn,
  HttpErrorResponse,
} from '@angular/common/http';
import { MessageService } from 'primeng/api';
import { catchError, throwError } from 'rxjs';

/**
 * errorInterceptor — functional HTTP interceptor that surfaces API errors
 * as PrimeNG toast notifications.
 *
 * Error mapping:
 *  400 — Shows the message from the response body (validation / bad request).
 *  403 — Permission denied message.
 *  404 — Resource not found message.
 *  500 — Generic server error message.
 *  401 — Skipped: handled by authInterceptor (token refresh / redirect to login).
 *
 * Registration: add to `withInterceptors([..., errorInterceptor])` in app.config.ts.
 * Must be placed AFTER authInterceptor so 401 is already handled upstream.
 */
export const errorInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
) => {
  const messageService = inject(MessageService);

  return next(req).pipe(
    catchError((error: unknown) => {
      // Only handle HTTP errors from Angular's HttpClient.
      if (!(error instanceof HttpErrorResponse)) {
        return throwError(() => error);
      }

      // 401 is handled by authInterceptor — skip it here.
      if (error.status === 401) {
        return throwError(() => error);
      }

      const detail = resolveErrorMessage(error);

      messageService.add({
        severity: 'error',
        summary: 'Error',
        detail,
        life: 6000,
      });

      return throwError(() => error);
    }),
  );
};

/**
 * Maps an HTTP error response to a user-friendly message string.
 * For 400 errors we attempt to extract the `message` field from the response
 * body, which NestJS validation errors typically provide.
 */
function resolveErrorMessage(error: HttpErrorResponse): string {
  switch (error.status) {
    case 400: {
      // NestJS returns validation messages as a string or string array.
      const body = error.error as { message?: string | string[] } | null;
      if (body?.message) {
        const msg = body.message;
        return Array.isArray(msg) ? msg.join('. ') : msg;
      }
      return 'Invalid request. Please check your input and try again.';
    }
    case 403:
      return "You don't have permission to perform this action.";
    case 404:
      return 'The requested resource was not found.';
    case 500:
      return 'Server error. Please try again later.';
    default:
      return `An error occurred (${error.status}). Please try again.`;
  }
}
