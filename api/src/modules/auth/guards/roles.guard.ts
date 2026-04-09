import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { UserRole } from '../../users/enums/user-role.enum';

/**
 * Global authorization guard that enforces role-based access control.
 *
 * Works in conjunction with the {@link Roles} decorator. When a handler
 * specifies one or more required roles, this guard checks the authenticated
 * user's role against the allowed list.
 *
 * If no `@Roles()` decorator is present, the guard allows the request
 * through (authentication alone is sufficient).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  /**
   * Evaluate whether the current user holds a required role.
   *
   * @param context - The current execution context.
   * @returns `true` if no roles are required or the user's role is in the list.
   * @throws ForbiddenException if the user lacks the required role.
   */
  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    /** No @Roles() decorator — allow any authenticated user. */
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.role) {
      throw new ForbiddenException(
        'You do not have permission to access this resource',
      );
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        'You do not have permission to access this resource',
      );
    }

    return true;
  }
}
