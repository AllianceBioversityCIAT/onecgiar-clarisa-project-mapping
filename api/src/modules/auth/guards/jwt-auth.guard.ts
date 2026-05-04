import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable, isObservable, lastValueFrom } from 'rxjs';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { RequestContextService } from '../../../common/context/request-context.service';
import { User } from '../../users/entities/user.entity';

/**
 * Global authentication guard that enforces JWT validation on all routes.
 *
 * Routes decorated with {@link Public} are excluded from authentication.
 * For all other routes, the guard delegates to the Passport 'jwt' strategy
 * which validates the locally-issued JWT and attaches the user to the
 * request.
 *
 * Once Passport attaches `request.user`, this guard binds
 * `request.user.id` into the active request-scoped context via
 * {@link RequestContextService.setUserId}. Downstream consumers (notably
 * `AuditService.record()`) read the user ID from that context to resolve
 * the actor for audit rows. Without this binding, every audit write from
 * an authenticated HTTP request would skip with `audit.record called
 * without request context and no actorOverride`.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly reflector: Reflector,
    private readonly requestContext: RequestContextService,
  ) {
    super();
  }

  /**
   * Determine whether the current request requires authentication and,
   * on success, propagate the authenticated user into the request
   * context.
   *
   * `super.canActivate()` may return a boolean, a Promise<boolean>, or
   * an Observable<boolean> depending on the underlying Passport
   * strategy — we normalise all three to a Promise so the user-id
   * binding step always runs after Passport finishes.
   *
   * @param context - The current execution context.
   * @returns `true` if the request is allowed, `false` or throws otherwise.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      /*
       * Public routes intentionally skip Passport. There is no
       * `request.user` in this branch, so we leave userId unset on the
       * request context. AuditService callers on public routes either
       * supply `actorOverride` (e.g. dev-login) or accept the skip with
       * a warning — both paths are correct.
       */
      return true;
    }

    /* Normalise the Passport result regardless of its concrete type. */
    const result = super.canActivate(context);
    const allowed = await this.toPromise(result);

    if (!allowed) {
      // Passport will normally have thrown UnauthorizedException
      // before we get here, but defend against a plain `false`.
      return false;
    }

    /*
     * Bind the authenticated user's ID onto the request context so
     * downstream services (AuditService in particular) can resolve
     * the actor without threading the user object through every call.
     *
     * `request.user` is set by `JwtStrategy.validate()` and is the full
     * User entity. We only need the numeric primary key here.
     */
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as User | undefined;
    if (user && typeof user.id === 'number') {
      this.requestContext.setUserId(user.id);
    }

    return true;
  }

  /**
   * Coerce Passport's polymorphic `canActivate` result into a Promise.
   * Keeps the call site tidy and avoids importing rxjs operators just
   * to handle the observable case.
   */
  private toPromise(
    result: boolean | Promise<boolean> | Observable<boolean>,
  ): Promise<boolean> {
    if (typeof result === 'boolean') {
      return Promise.resolve(result);
    }
    if (isObservable(result)) {
      return lastValueFrom(result);
    }
    return result;
  }
}
