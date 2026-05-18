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
export const roleGuard = (...requiredRoles: Array<User['role']>): CanActivateFn => {
  return (): boolean => {
    const authService = inject(AuthService);
    const router = inject(Router);

    const userRole = authService.currentUser()?.role ?? null;
    const hasRequiredRole = requiredRoles.includes(userRole);

    if (hasRequiredRole) {
      return true;
    }

    // Redirect to the appropriate default page based on role.
    // workflow_admin → their Needs Assistance queue (no dashboard).
    // unit_admin → projects list (their primary work surface; no dashboard).
    // All others → dashboard.
    let fallback = '/dashboard';
    if (userRole === 'workflow_admin') fallback = '/needs-assistance';
    else if (userRole === 'unit_admin') fallback = '/projects';

    router.navigate([fallback]);
    return false;
  };
};

/**
 * dashboardAccessGuard — blocks roles that have no dashboard view.
 *
 * - workflow_admin: lands on the Needs Assistance queue (their default page).
 * - unit_admin: lands on the projects list (their primary work surface).
 * - no role (null): lands on the projects list (read-only access only).
 *
 * The dashboard component has admin / program_rep / center_rep branches; all
 * other authenticated users are routed elsewhere.
 */
export const dashboardAccessGuard: CanActivateFn = (): boolean => {
  const authService = inject(AuthService);
  const router = inject(Router);

  const role = authService.currentUser()?.role ?? null;

  if (role === 'workflow_admin') {
    router.navigate(['/needs-assistance']);
    return false;
  }

  if (role === 'unit_admin' || role === null) {
    router.navigate(['/projects']);
    return false;
  }

  return true;
};
