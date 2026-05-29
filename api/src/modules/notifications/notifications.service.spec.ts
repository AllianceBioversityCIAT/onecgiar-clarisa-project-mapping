import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { NotificationsService } from './notifications.service';
import { NOTIFICATIONS_CLIENT } from './notifications.module';

/**
 * Unit tests for {@link NotificationsService}.
 *
 * The CGIAR notification microservice docs require an exact payload shape
 * (`{ auth, data: { from, emailBody: { to, cc, bcc, subject, message } } }`)
 * and Buffer-wrapped HTML in `socketFile`. These tests pin that shape and
 * the behaviour of the kill-switch / dry-run flags so we never accidentally
 * publish real messages from CI or local dev.
 */
describe('NotificationsService', () => {
  type ConfigKey =
    | 'notifications.enabled'
    | 'notifications.dryRun'
    | 'notifications.rabbitmqUrl'
    | 'notifications.queue'
    | 'notifications.routingKey'
    | 'notifications.clientId'
    | 'notifications.secret'
    | 'notifications.from.email'
    | 'notifications.from.name';

  const buildModule = async (
    overrides: Partial<Record<ConfigKey, unknown>>,
    client: ClientProxy | null,
  ): Promise<{
    service: NotificationsService;
    emit: jest.Mock;
  }> => {
    const defaults: Record<ConfigKey, unknown> = {
      'notifications.enabled': true,
      'notifications.dryRun': false,
      'notifications.rabbitmqUrl': 'amqps://broker',
      'notifications.queue': 'notifications_queue',
      'notifications.routingKey': 'send',
      'notifications.clientId': 'test-client',
      'notifications.secret': 'test-secret',
      'notifications.from.email': 'noreply@cgiar.org',
      'notifications.from.name': 'PRMS',
    };
    const config = { ...defaults, ...overrides };

    const emit = jest.fn().mockReturnValue(of(undefined));
    const fakeClient =
      client === null
        ? null
        : (client ??
          ({
            emit,
            connect: jest.fn(),
            close: jest.fn(),
          } as unknown as ClientProxy));

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: ConfigService,
          useValue: { get: (key: ConfigKey) => config[key] },
        },
        { provide: NOTIFICATIONS_CLIENT, useValue: fakeClient },
      ],
    }).compile();

    const service = moduleRef.get(NotificationsService);
    return { service, emit };
  };

  describe('buildPayload', () => {
    it('produces the documented wire shape with Buffer-wrapped HTML', async () => {
      const { service } = await buildModule({}, null);

      const payload = service.buildPayload({
        to: ['user@example.com'],
        cc: ['cc@example.com'],
        subject: 'Hello',
        text: 'Plain text',
        html: '<p>Hi</p>',
      });

      expect(payload).toEqual({
        auth: { username: 'test-client', password: 'test-secret' },
        data: {
          // Both fields come from NOTIFICATIONS_FROM_EMAIL /
          // NOTIFICATIONS_FROM_NAME (mocked via ConfigService here).
          from: { email: 'noreply@cgiar.org', name: 'PRMS' },
          emailBody: {
            subject: 'Hello',
            // Recipients are emitted as comma-separated strings — the
            // Notification Microservice calls `.split(',')` on these.
            to: 'user@example.com',
            cc: 'cc@example.com',
            bcc: '',
            message: {
              text: 'Plain text',
              socketFile: Buffer.from('<p>Hi</p>'),
            },
          },
        },
      });
    });

    it('omits message fields that were not provided', async () => {
      const { service } = await buildModule({}, null);

      const payload = service.buildPayload({
        to: ['u@example.com'],
        subject: 'No body',
      });

      expect(payload.data.emailBody.message).toEqual({});
      expect(payload.data.emailBody.cc).toBe('');
      expect(payload.data.emailBody.bcc).toBe('');
    });

    it('honours a per-call from override', async () => {
      const { service } = await buildModule({}, null);

      const payload = service.buildPayload({
        to: ['u@example.com'],
        subject: 'Override',
        from: { email: 'system@prms.cgiar.org', name: 'System' },
      });

      expect(payload.data.from).toEqual({
        email: 'system@prms.cgiar.org',
        name: 'System',
      });
    });
  });

  describe('send', () => {
    it('returns "disabled" without touching the client when notifications.enabled=false', async () => {
      const emit = jest.fn().mockReturnValue(of(undefined));
      const client = {
        emit,
        connect: jest.fn(),
        close: jest.fn(),
      } as unknown as ClientProxy;
      const { service } = await buildModule(
        { 'notifications.enabled': false },
        client,
      );

      const result = await service.send({
        to: ['u@example.com'],
        subject: 'x',
        text: 't',
      });

      expect(result.status).toBe('disabled');
      expect(emit).not.toHaveBeenCalled();
    });

    it('returns "dry_run" and skips emit when notifications.dryRun=true', async () => {
      const emit = jest.fn().mockReturnValue(of(undefined));
      const client = {
        emit,
        connect: jest.fn(),
        close: jest.fn(),
      } as unknown as ClientProxy;
      const { service } = await buildModule(
        { 'notifications.dryRun': true },
        client,
      );

      const result = await service.send({
        to: ['u@example.com'],
        subject: 'x',
        text: 't',
      });

      expect(result.status).toBe('dry_run');
      expect(emit).not.toHaveBeenCalled();
    });

    it('returns "dry_run" when enabled but no client was wired (no broker)', async () => {
      const { service } = await buildModule({}, null);

      const result = await service.send({
        to: ['u@example.com'],
        subject: 'x',
        text: 't',
      });

      expect(result.status).toBe('dry_run');
    });

    it('publishes via emit("send", payload) when enabled and not dry-run', async () => {
      const emit = jest.fn().mockReturnValue(of(undefined));
      const client = {
        emit,
        connect: jest.fn(),
        close: jest.fn(),
      } as unknown as ClientProxy;
      const { service } = await buildModule({}, client);

      const result = await service.send({
        to: ['u@example.com'],
        subject: 'Hello',
        html: '<p>Hi</p>',
      });

      expect(result.status).toBe('published');
      expect(emit).toHaveBeenCalledTimes(1);
      const [routingKey, payload] = emit.mock.calls[0];
      expect(routingKey).toBe('send');
      expect(payload.auth).toEqual({
        username: 'test-client',
        password: 'test-secret',
      });
      expect(payload.data.emailBody.to).toBe('u@example.com');
      // `.toEqual` does deep equality — Buffer.from(...) returns a new
      // instance each call, so identity comparison via `.toBe` would
      // never match.
      expect(payload.data.emailBody.message.socketFile).toEqual(
        Buffer.from('<p>Hi</p>'),
      );
    });

    it('swallows broker errors and returns "dry_run" so callers are not aborted', async () => {
      const emit = jest
        .fn()
        .mockReturnValue(throwError(() => new Error('broker down')));
      const client = {
        emit,
        connect: jest.fn(),
        close: jest.fn(),
      } as unknown as ClientProxy;
      const { service } = await buildModule({}, client);

      const result = await service.send({
        to: ['u@example.com'],
        subject: 'x',
        text: 't',
      });

      expect(result.status).toBe('dry_run');
      expect(emit).toHaveBeenCalledTimes(1);
    });
  });
});
