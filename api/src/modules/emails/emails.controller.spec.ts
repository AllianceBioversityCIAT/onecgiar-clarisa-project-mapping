/**
 * Unit tests for EmailsController.
 *
 * These tests verify structural concerns that are not covered by the
 * service spec: decorator metadata, and that the controller correctly
 * threads the current user's id from the `@CurrentUser()` param
 * decorator through to the service call.
 *
 * Route-level auth integration (403 for non-admin JWT) is out of scope
 * here and belongs in e2e tests.
 */
import { Test, TestingModule } from '@nestjs/testing';

import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { EmailStatus } from './enums/email-status.enum';
import { EmailBodyFormat } from './enums/email-body-format.enum';
import { EmailDetailDto } from './dto/email-detail.dto';
import { SendTestEmailDto } from './dto/send-test-email.dto';
import { User } from '../users/entities/user.entity';

/* ─────────────────────────── Helpers ─────────────────────────── */

function makeDetailDto(overrides: Partial<EmailDetailDto> = {}): EmailDetailDto {
  return {
    id: 1,
    toUserId: null,
    toEmail: 'rep@cgiar.org',
    toUserName: null,
    subject: 'Test',
    body: '<p>Hello</p>',
    bodyFormat: EmailBodyFormat.HTML,
    status: EmailStatus.QUEUED,
    priority: 5,
    attempts: 0,
    maxAttempts: 5,
    lastError: null,
    lockedAt: null,
    lockedBy: null,
    nextAttemptAt: null,
    sentAt: null,
    queuedAt: new Date(),
    createdByUserId: null,
    createdByUserName: null,
    templateKey: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeUser(id: number): Partial<User> {
  return { id, email: 'admin@example.com', role: UserRole.ADMIN };
}

/* ─────────────────────────── Suite ─────────────────────────── */

describe('EmailsController', () => {
  let controller: EmailsController;
  let service: {
    list: jest.Mock;
    findOne: jest.Mock;
    retry: jest.Mock;
    sendTest: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      findOne: jest.fn(),
      retry: jest.fn(),
      sendTest: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmailsController],
      providers: [{ provide: EmailsService, useValue: service }],
    }).compile();

    controller = module.get(EmailsController);
  });

  /* --- @Roles metadata ---------------------------------------------------- */

  describe('@Roles decorator', () => {
    it('restricts the controller class to ADMIN role via @Roles metadata', () => {
      // The @Roles decorator on the class sets metadata on the constructor.
      // Guards read this key at runtime; this test pins the static declaration.
      const roles = Reflect.getMetadata(ROLES_KEY, EmailsController);
      expect(roles).toEqual([UserRole.ADMIN]);
    });
  });

  /* --- retry() ------------------------------------------------------------ */

  describe('retry()', () => {
    it('passes the actor user id from @CurrentUser() to service.retry()', async () => {
      const user = makeUser(42) as User;
      const detail = makeDetailDto({ id: 5, status: EmailStatus.QUEUED });
      service.retry.mockResolvedValueOnce(detail);

      const result = await controller.retry(5, user);

      expect(service.retry).toHaveBeenCalledWith(5, 42);
      expect(result).toBe(detail);
    });

    it('forwards the parsed integer id (not a string) to service.retry()', async () => {
      // ParseIntPipe is declared on the route; the controller receives
      // a number. Verify the controller does not coerce/wrap it.
      const user = makeUser(1) as User;
      service.retry.mockResolvedValueOnce(makeDetailDto());

      await controller.retry(7, user);

      const [passedId] = service.retry.mock.calls[0] as [number, number];
      expect(typeof passedId).toBe('number');
      expect(passedId).toBe(7);
    });
  });

  /* --- findOne() ---------------------------------------------------------- */

  describe('findOne()', () => {
    it('delegates to service.findOne and returns the result', async () => {
      const detail = makeDetailDto({ id: 3 });
      service.findOne.mockResolvedValueOnce(detail);

      const result = await controller.findOne(3);

      expect(service.findOne).toHaveBeenCalledWith(3);
      expect(result).toBe(detail);
    });
  });

  /* --- list() ------------------------------------------------------------- */

  describe('list()', () => {
    it('delegates to service.list and returns the paginated result', async () => {
      const expected = { data: [], total: 0, page: 1, limit: 25 };
      service.list.mockResolvedValueOnce(expected);

      const result = await controller.list({} as any);

      expect(service.list).toHaveBeenCalledWith({});
      expect(result).toBe(expected);
    });
  });

  /* --- sendTest() --------------------------------------------------------- */

  describe('sendTest()', () => {
    /**
     * Test 7 — Wiring: the controller method delegates to
     * service.sendTest(dto.toUserId, user.id) verbatim.
     */
    it('delegates to service.sendTest(dto.toUserId, user.id) and returns the result verbatim', async () => {
      const dto: SendTestEmailDto = { toUserId: 42 };
      const user = makeUser(99) as User;
      const serviceResult = {
        id: 55,
        toUserId: 42,
        toEmail: 'bob@example.com',
        subject: 'PRMS Test Email',
        status: 'queued' as const,
      };
      service.sendTest.mockResolvedValueOnce(serviceResult);

      const result = await controller.sendTest(dto, user);

      // Wiring: service called with the right arguments.
      expect(service.sendTest).toHaveBeenCalledWith(42, 99);
      // Return value is the service result, not a wrapper.
      expect(result).toBe(serviceResult);
    });

    it('passes dto.toUserId (number, not the whole dto) to the service', async () => {
      const dto: SendTestEmailDto = { toUserId: 7 };
      const user = makeUser(1) as User;
      service.sendTest.mockResolvedValueOnce({
        id: 1,
        toUserId: 7,
        toEmail: 'x@x.com',
        subject: 'PRMS Test Email',
        status: 'queued' as const,
      });

      await controller.sendTest(dto, user);

      const [passedUserId] = service.sendTest.mock.calls[0] as [number, number];
      expect(typeof passedUserId).toBe('number');
      expect(passedUserId).toBe(7);
    });

    /**
     * Test 8 — Admin-only: The class-level @Roles(UserRole.ADMIN) covers
     * every method including sendTest. We confirm no per-method override
     * weakens this for sendTest by verifying the class metadata still
     * reflects the single ADMIN value and that no method-level ROLES_KEY
     * metadata exists on sendTest.
     */
    it('is covered by the class-level @Roles(ADMIN) — no per-method override weakens it', () => {
      // Class-level check (already present in the existing suite but
      // re-asserted here to make the sendTest inheritance explicit).
      const classRoles = Reflect.getMetadata(ROLES_KEY, EmailsController);
      expect(classRoles).toEqual([UserRole.ADMIN]);

      // Confirm sendTest has no independent ROLES_KEY metadata that could
      // override (downgrade) the class-level restriction.
      const methodRoles = Reflect.getMetadata(
        ROLES_KEY,
        EmailsController.prototype,
        'sendTest',
      );
      // undefined means "inherits from class level" — which is what we want.
      expect(methodRoles).toBeUndefined();
    });
  });
});
