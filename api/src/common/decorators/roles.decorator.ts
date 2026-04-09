import { SetMetadata } from '@nestjs/common';
import { UserRole } from '../../modules/users/enums/user-role.enum';

/**
 * Metadata key used by {@link RolesGuard} to read the required roles
 * from a route handler.
 */
export const ROLES_KEY = 'roles';

/**
 * Restricts access to users who hold one of the specified roles.
 *
 * The global {@link RolesGuard} reads the metadata set by this decorator
 * and returns 403 Forbidden when the authenticated user's role is not
 * in the allowed list.
 *
 * @param roles - One or more {@link UserRole} values that are permitted.
 *
 * @example
 * ```ts
 * @Roles(UserRole.ADMIN)
 * @Get('users')
 * listUsers() { ... }
 * ```
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
