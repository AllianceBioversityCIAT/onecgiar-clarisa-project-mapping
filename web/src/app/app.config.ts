import {
  ApplicationConfig,
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {
  provideRouter,
  withComponentInputBinding,
  withRouterConfig,
} from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { providePrimeNG } from 'primeng/config';
import { MessageService } from 'primeng/api';
import Aura from '@primeng/themes/aura';

import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { GlobalErrorHandler } from './core/error/global-error-handler';

/**
 * Root application configuration.
 *
 * Key decisions:
 *  - withComponentInputBinding() enables route data/params to be bound
 *    directly as component @Input()s and activates the built-in TitleStrategy
 *    so each route's `title` property is reflected in the browser tab.
 *  - withInterceptors([authInterceptor, errorInterceptor]) chains both
 *    functional interceptors. Auth runs first (handles 401 refresh); the
 *    error interceptor runs second and skips 401 (already managed by auth).
 *  - GlobalErrorHandler replaces Angular's default ErrorHandler to surface
 *    uncaught errors as PrimeNG toast notifications.
 *  - MessageService is provided at the root level so GlobalErrorHandler and
 *    errorInterceptor can inject it without needing it in every component.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),

    // Router — enable component input binding (also activates TitleStrategy
    // so route `title` values are applied to the document title automatically).
    provideRouter(
      routes,
      withComponentInputBinding(),
      withRouterConfig({ paramsInheritanceStrategy: 'always' }),
    ),

    provideAnimationsAsync(),

    // HTTP — auth interceptor first, then error interceptor.
    provideHttpClient(
      withInterceptors([authInterceptor, errorInterceptor]),
    ),

    // PrimeNG theme
    providePrimeNG({
      theme: {
        preset: Aura,
        options: {
          prefix: 'p',
          darkModeSelector: '.dark-mode',
        },
      },
    }),

    // PrimeNG MessageService — shared instance for toast notifications.
    // Required by both GlobalErrorHandler and errorInterceptor.
    MessageService,

    // Replace Angular's default error handler with our custom one that shows toasts.
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
  ],
};
