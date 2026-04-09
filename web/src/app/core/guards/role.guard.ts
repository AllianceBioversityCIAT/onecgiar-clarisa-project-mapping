import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { User } from '../models/user.model';

/**
 * roleGuard — functional guard factory for role-based route protection.
 *
 * Accepts one or more required roles. The route is activated only when the
 * current user holds at least one of the specified roles. If the user's role
 * does not match, they are redirected to the dashboard.
 *
 * Usage in route config:
 *   canActivate: [roleGuard('admin')]
 *   canActivate: [roleGuard('admin', 'program_rep')]
 */
export const roleGuard = (
  ...requiredRoles: Array<User['role']>
): CanActivateFn => {
  return (): boolean => {
    const authService = inject(AuthService);
    const router = inject(Router);

    const userRole = authService.currentUser()?.role ?? null;
    const hasRequiredRole = requiredRoles.includes(userRole);

    if (hasRequiredRole) {
      return true;
    }

    // Redirect unauthorized users to the dashboard.
    router.navigate(['/dashboard']);
    return false;
  };
};
