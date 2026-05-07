import { inject } from '@angular/core';
import {
  HttpInterceptorFn,
  HttpRequest,
  HttpHandlerFn,
  HttpErrorResponse,
} from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, switchMap, throwError } from 'rxjs';
import { from } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { environment } from '../../../environments/environment';

/**
 * authInterceptor — functional HTTP interceptor for Angular 21.
 *
 * Responsibilities:
 *  1. Attach the `Authorization: Bearer <token>` header to every outbound
 *     request that targets the configured API domain. Public endpoints that
 *     do not yet have a token (e.g. /auth/login) are forwarded as-is.
 *  2. On a 401 response, attempt a silent token refresh via AuthService.
 *     If the refresh succeeds, retry the original request with the new token.
 *     If the refresh fails (cookie expired), clear the session and redirect
 *     the user to the login page.
 */
export const authInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  /**
   * Only intercept requests destined for our API domain.
   * Requests to CDNs, analytics, or external services are forwarded unchanged.
   */
  const isApiRequest = req.url.startsWith(environment.apiUrl);

  if (!isApiRequest) {
    return next(req);
  }

  /** Clones the request and adds the Bearer token header if a token is present. */
  const addAuthHeader = (request: HttpRequest<unknown>): HttpRequest<unknown> => {
    const token = authService.getAccessToken();
    if (!token) return request;
    return request.clone({
      setHeaders: { Authorization: `Bearer ${token}` },
    });
  };

  return next(addAuthHeader(req)).pipe(
    catchError((error: unknown) => {
      // Only handle 401 Unauthorized responses from our API.
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }

      // Avoid infinite refresh loops: if the failing request is itself
      // a refresh or logout call, redirect to login immediately.
      const isAuthEndpoint =
        req.url.includes('/auth/refresh') ||
        req.url.includes('/auth/logout') ||
        req.url.includes('/auth/me');

      if (isAuthEndpoint) {
        authService.rememberReturnUrl(router.url);
        router.navigate(['/auth']);
        return throwError(() => error);
      }

      // Attempt a silent token refresh, then retry the original request.
      return from(authService.refreshToken()).pipe(
        switchMap((refreshed: boolean) => {
          if (!refreshed) {
            // Refresh cookie is gone — send user back to login.
            authService.rememberReturnUrl(router.url);
            router.navigate(['/auth']);
            return throwError(() => error);
          }
          // Retry the original request with the newly obtained token.
          return next(addAuthHeader(req));
        }),
      );
    }),
  );
};
