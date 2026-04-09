import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * authGuard — functional route guard that protects authenticated routes.
 *
 * Waits for the initial session recovery (loadUser via refresh cookie)
 * to complete before checking auth status. This prevents a race condition
 * where the guard fires before the async loadUser() has finished,
 * which would incorrectly redirect to login on page refresh.
 */
export const authGuard: CanActivateFn = async (): Promise<boolean> => {
  const authService = inject(AuthService);

  // Wait for the initial session recovery to finish before checking.
  await authService.initialized;

  if (authService.isAuthenticated()) {
    return true;
  }

  // Redirect the browser to the Cognito login page.
  await authService.login();
  return false;
};
