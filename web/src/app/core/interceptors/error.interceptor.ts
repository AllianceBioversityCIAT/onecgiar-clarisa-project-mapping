import { inject } from '@angular/core';
import {
  HttpInterceptorFn,
  HttpRequest,
  HttpHandlerFn,
  HttpErrorResponse,
  HttpContextToken,
} from '@angular/common/http';
import { Router } from '@angular/router';
import { MessageService } from 'primeng/api';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

/**
 * Error code emitted by the backend ActiveCenterInterceptor (A-5) when
 * the X-Active-Center header references a center that is no longer
 * assigned to the authenticated user.
 */
const ACTIVE_CENTER_INVALID_CODE = 'ACTIVE_CENTER_INVALID';

/**
 * HttpContextToken used as a loop guard on the ACTIVE_CENTER_INVALID
 * recovery path. When the interceptor retries a request after resetting
 * the active center, it sets this token to true on the cloned request.
 * If the retried request also returns ACTIVE_CENTER_INVALID, we give up
 * instead of recursing indefinitely.
 */
export const ACTIVE_CENTER_RETRIED = new HttpContextToken<boolean>(() => false);

/**
 * Minimum milliseconds between ACTIVE_CENTER_INVALID toast messages.
 * Guards against multiple parallel requests all firing a toast at once.
 */
const TOAST_DEBOUNCE_MS = 5000;

/** Tracks when the last ACTIVE_CENTER_INVALID toast was shown (module-level closure). */
let lastCenterInvalidToastAt = 0;

/**
 * errorInterceptor — functional HTTP interceptor that surfaces API errors
 * as PrimeNG toast notifications.
 *
 * Error mapping:
 *  400 — Shows the message from the response body (validation / bad request).
 *  401 — Skipped: handled by authInterceptor (token refresh / redirect to login).
 *  403 with code ACTIVE_CENTER_INVALID — Recovery flow:
 *        1. Re-fetch /auth/me to pick up updated centerIds.
 *        2. Call resetActiveCenterToFirst() to set a valid active center.
 *        3. Retry the original request once (loop-guarded via ACTIVE_CENTER_RETRIED).
 *        4. If centerIds is empty after refresh, navigate to /projects.
 *        5. Show a toast informing the user their centers changed.
 *  403 (other) — Permission denied message.
 *  404 — Resource not found message.
 *  500 — Generic server error message.
 *
 * Registration: add to `withInterceptors([..., errorInterceptor])` in app.config.ts.
 * Must be placed AFTER authInterceptor so 401 is already handled upstream.
 */
export const errorInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
) => {
  const messageService = inject(MessageService);
  const authService = inject(AuthService);
  const router = inject(Router);

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

      // -----------------------------------------------------------------------
      // 403 ACTIVE_CENTER_INVALID — graceful center recovery (B-6)
      // -----------------------------------------------------------------------
      if (error.status === 403 && error.error?.code === ACTIVE_CENTER_INVALID_CODE) {
        // Loop guard: if this request was already a retry, give up gracefully.
        if (req.context.get(ACTIVE_CENTER_RETRIED) === true) {
          messageService.add({
            severity: 'error',
            summary: 'Center access changed',
            detail: 'Your assigned centers have changed. Please refresh the page or log out.',
            life: 8000,
          });
          return throwError(() => error);
        }

        // Refresh /auth/me to pick up updated centerIds, then retry once.
        return from(authService.refreshCurrentUser()).pipe(
          switchMap(() => {
            authService.resetActiveCenterToFirst();
            const user = authService.currentUser();

            // If the user no longer has any centers (role may have changed),
            // we cannot recover the active-center concept — navigate away.
            if (!user || user.centerIds.length === 0) {
              router.navigate(['/projects']);
              return throwError(() => error);
            }

            // Show a debounced info toast so parallel requests don't stack toasts.
            const now = Date.now();
            if (now - lastCenterInvalidToastAt > TOAST_DEBOUNCE_MS) {
              lastCenterInvalidToastAt = now;
              const centerName = authService.activeCenter()?.name ?? 'your primary center';
              messageService.add({
                severity: 'info',
                summary: 'Centers updated',
                detail: `Your assigned centers changed — switched to ${centerName}.`,
                life: 6000,
              });
            }

            // Retry the original request with the loop-guard flag set.
            const retried = req.clone({
              context: req.context.set(ACTIVE_CENTER_RETRIED, true),
            });
            return next(retried);
          }),
          catchError((refreshErr: unknown) => {
            // /auth/me failed — likely auth expired entirely; let upstream handle.
            return throwError(() => refreshErr);
          }),
        );
      }

      // -----------------------------------------------------------------------
      // All other HTTP errors — show a toast with a user-friendly message.
      // -----------------------------------------------------------------------
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
