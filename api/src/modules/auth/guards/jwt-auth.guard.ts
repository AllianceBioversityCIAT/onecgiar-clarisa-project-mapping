import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';

/**
 * Global authentication guard that enforces JWT validation on all routes.
 *
 * Routes decorated with {@link Public} are excluded from authentication.
 * For all other routes, the guard delegates to the Passport 'jwt' strategy
 * which validates the locally-issued JWT and attaches the user to the request.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  /**
   * Determine whether the current request requires authentication.
   *
   * If the handler or its controller is marked with `@Public()`, the
   * request is allowed through without a valid JWT.
   *
   * @param context - The current execution context.
   * @returns `true` to allow the request, or delegates to Passport's JWT validation.
   */
  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }
}
