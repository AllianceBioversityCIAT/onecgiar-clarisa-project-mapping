import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Custom parameter decorator that extracts the authenticated user
 * from the current HTTP request.
 *
 * The user object is expected to be attached to `request.user` by
 * an authentication guard (e.g., a JWT/Cognito guard).
 *
 * @example
 * ```ts
 * @Get('profile')
 * getProfile(@CurrentUser() user: User) {
 *   return user;
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
