/**
 * Unit tests for MappingSessionGuard.
 *
 * Pins the three rules the annual kill switch depends on:
 *  1. Reads (GET/HEAD/OPTIONS) are never blocked, open or closed.
 *  2. Every other verb is blocked once `mapping_session_closed` is on —
 *     role-blind, with the exact approved notice and the
 *     `MAPPING_SESSION_CLOSED` code on the 403 body.
 *  3. A route carrying `@MappingSessionExempt()` (TOC contribution) stays
 *     writable while the session is closed.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { MappingSessionGuard } from './mapping-session.guard';
import {
  MAPPING_SESSION_CLOSED_CODE,
  MAPPING_SESSION_CLOSED_MESSAGE,
} from '../constants/mapping-session.constants';
import { SettingsService } from '../../modules/settings/settings.service';

/** Minimal ExecutionContext double exposing only what the guard reads. */
function makeContext(method: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, originalUrl: `/mappings/1/agree` }),
    }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('MappingSessionGuard', () => {
  let settings: { isMappingSessionClosed: jest.Mock };
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: MappingSessionGuard;

  beforeEach(() => {
    settings = { isMappingSessionClosed: jest.fn(async () => false) };
    // Not exempt unless a test says otherwise.
    reflector = { getAllAndOverride: jest.fn(() => undefined) };
    guard = new MappingSessionGuard(
      settings as unknown as SettingsService,
      reflector as unknown as Reflector,
    );
  });

  describe('when the session is open', () => {
    it.each(['GET', 'POST', 'PATCH', 'DELETE'])('allows %s', async (method) => {
      await expect(guard.canActivate(makeContext(method))).resolves.toBe(true);
    });
  });

  describe('when the session is closed', () => {
    beforeEach(() => {
      settings.isMappingSessionClosed.mockResolvedValue(true);
    });

    it.each(['GET', 'HEAD', 'OPTIONS'])(
      'still allows the read verb %s',
      async (method) => {
        await expect(guard.canActivate(makeContext(method))).resolves.toBe(
          true,
        );
      },
    );

    it('short-circuits reads without hitting the settings row', async () => {
      await guard.canActivate(makeContext('GET'));
      expect(settings.isMappingSessionClosed).not.toHaveBeenCalled();
    });

    it('allows a route marked @MappingSessionExempt() (TOC contribution)', async () => {
      reflector.getAllAndOverride.mockReturnValue(true);

      await expect(guard.canActivate(makeContext('PATCH'))).resolves.toBe(true);
      // Exemption short-circuits before the settings lookup.
      expect(settings.isMappingSessionClosed).not.toHaveBeenCalled();
    });

    it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
      'blocks the mutating verb %s with the approved notice',
      async (method) => {
        await expect(guard.canActivate(makeContext(method))).rejects.toThrow(
          ForbiddenException,
        );

        await expect(
          guard.canActivate(makeContext(method)),
        ).rejects.toMatchObject({
          response: {
            statusCode: 403,
            code: MAPPING_SESSION_CLOSED_CODE,
            message: MAPPING_SESSION_CLOSED_MESSAGE,
          },
        });
      },
    );
  });
});
