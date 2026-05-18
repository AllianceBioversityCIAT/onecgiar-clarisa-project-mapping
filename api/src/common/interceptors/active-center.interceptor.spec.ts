import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { of } from 'rxjs';
import {
  ACTIVE_CENTER_INVALID_CODE,
  ActiveCenterInterceptor,
} from './active-center.interceptor';

/**
 * Unit tests for {@link ActiveCenterInterceptor}.
 *
 * Each test builds a minimal `ExecutionContext` + `CallHandler` stub.
 * Pass-through cases assert `req.user.centerId` is untouched and the
 * downstream handler observable is returned. Reject cases assert the
 * synchronous throw shape — specifically the `code: 'ACTIVE_CENTER_INVALID'`
 * discriminator that the frontend B-6 recovery flow relies on.
 *
 * Pattern: the interceptor validates synchronously and throws BEFORE
 * returning the observable, so we wrap calls in `expect(() => ...)`
 * and inspect the caught `ForbiddenException.getResponse()` payload.
 */
describe('ActiveCenterInterceptor', () => {
  let interceptor: ActiveCenterInterceptor;

  beforeEach(() => {
    interceptor = new ActiveCenterInterceptor();
  });

  /**
   * Build a fake Nest `ExecutionContext` whose `switchToHttp().getRequest()`
   * yields the supplied `{ user, headers }` stub.
   */
  function buildContext(req: {
    user?: Record<string, unknown> | undefined;
    headers: Record<string, string | undefined>;
  }): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
        getNext: () => undefined,
      }),
    } as unknown as ExecutionContext;
  }

  /**
   * Trivial `CallHandler` whose `handle()` returns an observable of `null`.
   * Sufficient to assert that the interceptor returns _some_ observable
   * on the non-error paths.
   */
  function buildHandler(): CallHandler {
    return { handle: () => of(null) };
  }

  /**
   * Run the interceptor expecting a synchronous throw, and return the
   * thrown exception so the test can inspect its body.
   */
  function expectForbidden(
    ctx: ExecutionContext,
    handler: CallHandler,
  ): ForbiddenException {
    try {
      interceptor.intercept(ctx, handler);
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      return err as ForbiddenException;
    }
    throw new Error('Expected ForbiddenException, but none was thrown');
  }

  /* --------------------------------------------------------------- */
  /* Case 1: No header — req.user.centerId unchanged                 */
  /* --------------------------------------------------------------- */
  it('passes through unchanged when no X-Active-Center header is present', () => {
    const user = { centerId: 5, centerIds: [1, 5], role: 'center_rep' };
    const ctx = buildContext({ user, headers: {} });
    const handler = buildHandler();

    const result = interceptor.intercept(ctx, handler);

    expect(user.centerId).toBe(5);
    expect(result).toBeDefined();
  });

  /* --------------------------------------------------------------- */
  /* Case 2: Valid header in centerIds — overlay applied             */
  /* --------------------------------------------------------------- */
  it('overlays req.user.centerId when X-Active-Center is in centerIds', () => {
    const user = { centerId: 1, centerIds: [1, 3], role: 'center_rep' };
    const ctx = buildContext({
      user,
      headers: { 'x-active-center': '3' },
    });
    const handler = buildHandler();

    const result = interceptor.intercept(ctx, handler);

    expect(user.centerId).toBe(3);
    expect(result).toBeDefined();
  });

  /* --------------------------------------------------------------- */
  /* Case 3: Header value not in centerIds — 403 ACTIVE_CENTER_INVALID */
  /* --------------------------------------------------------------- */
  it('throws ForbiddenException with ACTIVE_CENTER_INVALID code when value is not in centerIds', () => {
    const user = { centerId: 1, centerIds: [1, 3], role: 'center_rep' };
    const ctx = buildContext({
      user,
      headers: { 'x-active-center': '5' },
    });
    const handler = buildHandler();

    const err = expectForbidden(ctx, handler);
    const body = err.getResponse() as Record<string, unknown>;

    expect(body).toEqual({
      statusCode: 403,
      code: ACTIVE_CENTER_INVALID_CODE,
      message: "Active center 5 is not in the user's assigned centers",
    });
    /* user.centerId must NOT have been mutated on the reject path. */
    expect(user.centerId).toBe(1);
  });

  /* --------------------------------------------------------------- */
  /* Case 4: Empty centerIds + header present — silent pass-through  */
  /* --------------------------------------------------------------- */
  it('passes through silently when centerIds is empty (non-center-rep role)', () => {
    /* Non-center-rep roles get centerIds = []. The header is meaningless
     * but harmless — we must NOT 403. This is a LOCKED design decision
     * (external tooling tolerance). The assertion below pins it. */
    const user = { centerId: null, centerIds: [], role: 'admin' };
    const ctx = buildContext({
      user,
      headers: { 'x-active-center': '3' },
    });
    const handler = buildHandler();

    /* Wrap in a function so the assertion message is clear if this ever
     * regresses to throwing. */
    expect(() => interceptor.intercept(ctx, handler)).not.toThrow();

    /* centerId must be untouched (still null). */
    expect(user.centerId).toBeNull();
  });

  /* --------------------------------------------------------------- */
  /* Case 5: Unauthenticated request — pass through                  */
  /* --------------------------------------------------------------- */
  it('passes through when there is no req.user (unauthenticated route)', () => {
    const ctx = buildContext({
      user: undefined,
      headers: { 'x-active-center': '3' },
    });
    const handler = buildHandler();

    expect(() => interceptor.intercept(ctx, handler)).not.toThrow();
  });

  /* --------------------------------------------------------------- */
  /* Case 6: Non-numeric header value — 403 ACTIVE_CENTER_INVALID    */
  /* --------------------------------------------------------------- */
  it('throws ACTIVE_CENTER_INVALID when header is non-numeric', () => {
    const user = { centerId: 1, centerIds: [1, 3], role: 'center_rep' };
    const ctx = buildContext({
      user,
      headers: { 'x-active-center': 'abc' },
    });
    const handler = buildHandler();

    const err = expectForbidden(ctx, handler);
    const body = err.getResponse() as Record<string, unknown>;

    expect(body.code).toBe(ACTIVE_CENTER_INVALID_CODE);
    expect(body.statusCode).toBe(403);
    expect(body.message).toBe('Invalid X-Active-Center header');
  });

  /* --------------------------------------------------------------- */
  /* Case 7: Negative or zero header — 403 ACTIVE_CENTER_INVALID     */
  /* --------------------------------------------------------------- */
  it('throws ACTIVE_CENTER_INVALID for "-1"', () => {
    const user = { centerId: 1, centerIds: [1, 3], role: 'center_rep' };
    const ctx = buildContext({
      user,
      headers: { 'x-active-center': '-1' },
    });
    const handler = buildHandler();

    const err = expectForbidden(ctx, handler);
    const body = err.getResponse() as Record<string, unknown>;

    expect(body.code).toBe(ACTIVE_CENTER_INVALID_CODE);
    expect(body.message).toBe('Invalid X-Active-Center header');
  });

  it('throws ACTIVE_CENTER_INVALID for "0"', () => {
    const user = { centerId: 1, centerIds: [1, 3], role: 'center_rep' };
    const ctx = buildContext({
      user,
      headers: { 'x-active-center': '0' },
    });
    const handler = buildHandler();

    const err = expectForbidden(ctx, handler);
    const body = err.getResponse() as Record<string, unknown>;

    expect(body.code).toBe(ACTIVE_CENTER_INVALID_CODE);
    expect(body.message).toBe('Invalid X-Active-Center header');
  });

  /* --------------------------------------------------------------- */
  /* Case 8: Empty-string header — treat as absent, pass through     */
  /* --------------------------------------------------------------- */
  it('treats an empty-string X-Active-Center as absent (pass through)', () => {
    const user = { centerId: 5, centerIds: [1, 5], role: 'center_rep' };
    const ctx = buildContext({
      user,
      headers: { 'x-active-center': '' },
    });
    const handler = buildHandler();

    expect(() => interceptor.intercept(ctx, handler)).not.toThrow();
    expect(user.centerId).toBe(5);
  });
});
