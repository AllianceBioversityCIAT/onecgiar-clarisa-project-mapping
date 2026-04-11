import { ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { providePrimeNG } from 'primeng/config';
import { ConfirmationService, MessageService } from 'primeng/api';
import { definePreset } from '@primeng/themes';
import Aura from '@primeng/themes/aura';

import { routes } from './app.routes';

/**
 * PRMS brand preset — overrides Aura's default emerald-green primary palette
 * with the PRMS blue accent scale so all PrimeNG components use the correct
 * brand colour (#5569dd) instead of Aura's injected #10b981.
 *
 * Using definePreset() is the only reliable approach: CSS variable overrides
 * in styles.scss are superseded by Aura's runtime token injection.
 */
const PrmsPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#eef0fb',
      100: '#d4d9f5',
      200: '#b0baed',
      300: '#8b9be5',
      400: '#6e80e1',
      500: '#5569dd',
      600: '#4454b8',
      700: '#333f93',
      800: '#232b6e',
      900: '#131749',
      950: '#0a0c27',
    },
    colorScheme: {
      light: {
        // PRMS surface palette — defined here so Aura's runtime token injection
        // cannot override these values after page load.
        surface: {
          0: '#ffffff',
          50: '#faf9f9',
          100: '#f4f2f2',
          200: '#e8e5e5',
          300: '#d5d0d0',
          400: '#b8b1b1',
          500: '#999191',
          600: '#777777',
          700: '#555555',
          800: '#333333',
          900: '#1a1a1a',
        },
      },
    },
  },
});
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
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),

    // PrimeNG theme — use PrmsPreset (Aura + PRMS primary palette)
    providePrimeNG({
      theme: {
        preset: PrmsPreset,
        options: {
          prefix: 'p',
          darkModeSelector: '.dark-mode',
        },
      },
    }),

    // PrimeNG MessageService — shared instance for toast notifications.
    // Required by both GlobalErrorHandler and errorInterceptor.
    MessageService,

    // PrimeNG ConfirmationService — provided at root so <p-confirmDialog />
    // can resolve it from any standalone component's template. In PrimeNG v21
    // the ConfirmDialog component's injector cannot see a provider declared
    // on the host standalone component itself (NG0201), so it must live here.
    ConfirmationService,

    // Replace Angular's default error handler with our custom one that shows toasts.
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
  ],
};
