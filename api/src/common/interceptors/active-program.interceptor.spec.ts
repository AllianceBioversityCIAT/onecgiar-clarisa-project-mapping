import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { of } from 'rxjs';
import {
  ACTIVE_PROGRAM_INVALID_CODE,
  ActiveProgramInterceptor,
} from './active-program.interceptor';

/**
 * Unit tests for {@link ActiveProgramInterceptor}.
 *
 * Each test builds a minimal `ExecutionContext` + `CallHandler` stub.
 * Pass-through cases assert `req.user.programId` is untouched and the
 * downstream handler observable is returned. Reject cases assert the
 * synchronous throw shape — specifically the `code: 'ACTIVE_PROGRAM_INVALID'`
 * discriminator that the frontend recovery flow relies on.
 *
 * Pattern: the interceptor validates synchronously and throws BEFORE
 * returning the observable, so we wrap calls in `expect(() => ...)`
 * and inspect the caught `ForbiddenException.getResponse()` payload.
 */
describe('ActiveProgramInterceptor', () => {
  let interceptor: ActiveProgramInterceptor;

  beforeEach(() => {
    interceptor = new ActiveProgramInterceptor();
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
  /* Case 1: No header — req.user.programId unchanged                 */
  /* --------------------------------------------------------------- */
  it('passes through unchanged when no X-Active-Program header is present', () => {
    const user = { programId: 5, programIds: [1, 5], role: 'program_rep' };
    const ctx = buildContext({ user, headers: {} });
    const handler = buildHandler();

    const result = interceptor.intercept(ctx, handler);

    expect(result).toBeDefined();
    expect(user.programId).toBe(5); // untouched
  });

  /* --------------------------------------------------------------- */
  /* Case 2: Valid header in programIds — overlays programId          */
  /* --------------------------------------------------------------- */
  it('overlays req.user.programId when header is a valid member of programIds', () => {
    const user = { programId: 1, programIds: [1, 5, 9], role: 'program_rep' };
    const ctx = buildContext({ user, headers: { 'x-active-program': '9' } });
    const handler = buildHandler();

    const result = interceptor.intercept(ctx, handler);

    expect(result).toBeDefined();
    expect(user.programId).toBe(9); // overlaid
  });

  /* --------------------------------------------------------------- */
  /* Case 3: Header matches primary — still overlays (no-op numeric) */
  /* --------------------------------------------------------------- */
  it('overlays even when the header value equals the current primary programId', () => {
    const user = { programId: 1, programIds: [1, 5], role: 'program_rep' };
    const ctx = buildContext({ user, headers: { 'x-active-program': '1' } });
    const handler = buildHandler();

    interceptor.intercept(ctx, handler);

    expect(user.programId).toBe(1);
  });

  /* --------------------------------------------------------------- */
  /* Case 4: Header id NOT in programIds → 403 ACTIVE_PROGRAM_INVALID */
  /* --------------------------------------------------------------- */
  it('throws 403 ACTIVE_PROGRAM_INVALID when header id is not in programIds', () => {
    const user = { programId: 1, programIds: [1, 5], role: 'program_rep' };
    const ctx = buildContext({ user, headers: { 'x-active-program': '99' } });
    const handler = buildHandler();

    const err = expectForbidden(ctx, handler);
    const body = err.getResponse() as Record<string, unknown>;

    expect(body.code).toBe(ACTIVE_PROGRAM_INVALID_CODE);
    expect(body.statusCode).toBe(403);
    expect(user.programId).toBe(1); // untouched
  });

  /* --------------------------------------------------------------- */
  /* Case 5: Malformed header (non-integer) → 403                    */
  /* --------------------------------------------------------------- */
  it('throws 403 ACTIVE_PROGRAM_INVALID for a non-integer header value', () => {
    const user = { programId: 1, programIds: [1, 5], role: 'program_rep' };
    const ctx = buildContext({
      user,
      headers: { 'x-active-program': 'abc' },
    });
    const handler = buildHandler();

    const err = expectForbidden(ctx, handler);
    const body = err.getResponse() as Record<string, unknown>;

    expect(body.code).toBe(ACTIVE_PROGRAM_INVALID_CODE);
  });

  /* --------------------------------------------------------------- */
  /* Case 6: Zero / negative header → 403                            */
  /* --------------------------------------------------------------- */
  it('throws 403 ACTIVE_PROGRAM_INVALID for a zero or negative header value', () => {
    for (const val of ['0', '-3']) {
      const user = { programId: 1, programIds: [1], role: 'program_rep' };
      const ctx = buildContext({
        user,
        headers: { 'x-active-program': val },
      });
      const err = expectForbidden(ctx, buildHandler());
      const body = err.getResponse() as Record<string, unknown>;
      expect(body.code).toBe(ACTIVE_PROGRAM_INVALID_CODE);
    }
  });

  /* --------------------------------------------------------------- */
  /* Case 7: Empty programIds (non-program-rep role) → pass-through  */
  /* --------------------------------------------------------------- */
  it('passes through silently when programIds is empty (non-program-rep role)', () => {
    const user = { programId: null, programIds: [], role: 'admin' };
    const ctx = buildContext({
      user,
      headers: { 'x-active-program': '5' },
    });
    const handler = buildHandler();

    // Should NOT throw — empty programIds means the header is irrelevant
    const result = interceptor.intercept(ctx, handler);
    expect(result).toBeDefined();
    expect(user.programId).toBeNull(); // untouched
  });

  /* --------------------------------------------------------------- */
  /* Case 8: No user (unauthenticated) → pass-through               */
  /* --------------------------------------------------------------- */
  it('passes through when req.user is undefined (public/unauthenticated route)', () => {
    const ctx = buildContext({
      user: undefined,
      headers: { 'x-active-program': '5' },
    });
    const handler = buildHandler();

    const result = interceptor.intercept(ctx, handler);
    expect(result).toBeDefined();
  });

  /* --------------------------------------------------------------- */
  /* Case 9: Empty header string → pass-through                      */
  /* --------------------------------------------------------------- */
  it('passes through when the X-Active-Program header is an empty string', () => {
    const user = { programId: 3, programIds: [3, 7], role: 'program_rep' };
    const ctx = buildContext({ user, headers: { 'x-active-program': '' } });
    const handler = buildHandler();

    const result = interceptor.intercept(ctx, handler);
    expect(result).toBeDefined();
    expect(user.programId).toBe(3); // untouched
  });
});
