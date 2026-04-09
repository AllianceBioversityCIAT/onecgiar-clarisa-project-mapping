import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key used by {@link JwtAuthGuard} to identify public endpoints
 * that bypass JWT authentication.
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a controller method as publicly accessible.
 *
 * When applied, the global {@link JwtAuthGuard} skips token validation
 * and allows the request through without authentication.
 *
 * @example
 * ```ts
 * @Public()
 * @Get('login')
 * getLoginUrl() { ... }
 * ```
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
