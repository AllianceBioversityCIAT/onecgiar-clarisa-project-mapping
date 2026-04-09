import { ErrorHandler, inject, Injectable, NgZone } from '@angular/core';
import { MessageService } from 'primeng/api';
import { environment } from '../../../environments/environment';

/**
 * GlobalErrorHandler — catches uncaught Angular errors at the application level.
 *
 * Any error that is not caught by a component or service bubbles up here.
 * We show a generic PrimeNG toast and log the error to the console in
 * development mode so developers can inspect the stack trace.
 *
 * Registration: `{ provide: ErrorHandler, useClass: GlobalErrorHandler }`
 * in app.config.ts providers.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  /**
   * NgZone is needed because Angular's ErrorHandler runs outside the Angular zone.
   * We must re-enter the zone before calling MessageService so that change detection
   * picks up the toast update.
   */
  private readonly ngZone = inject(NgZone);
  private readonly messageService = inject(MessageService);

  handleError(error: unknown): void {
    // Log the full error in development to aid debugging.
    if (!environment.production) {
      console.error('[GlobalErrorHandler]', error);
    }

    // Re-enter Angular zone so the toast renders correctly.
    this.ngZone.run(() => {
      this.messageService.add({
        severity: 'error',
        summary: 'Unexpected Error',
        detail: 'An unexpected error occurred. Please try again.',
        life: 5000,
      });
    });
  }
}
