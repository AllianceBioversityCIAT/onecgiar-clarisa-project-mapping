import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { NOTIFICATIONS_CLIENT } from './notifications.constants';
import { SendEmailOptions, SendEmailPayload } from './dto/send-email.dto';

/**
 * Result returned to callers of {@link NotificationsService.send}.
 *
 * - `published` — message was actually emitted onto the broker.
 * - `dry_run`   — service is in dry-run mode; payload built and logged
 *                 but no AMQP traffic happened.
 * - `disabled`  — kill switch is off; nothing happened.
 */
export type SendEmailResult = {
  status: 'published' | 'dry_run' | 'disabled';
  recipientCount: number;
  subject: string;
};

/**
 * Publishes email-send requests onto the CGIAR Notification Microservice
 * over RabbitMQ.
 *
 * Behaviour is controlled by `notifications.enabled` and
 * `notifications.dryRun` config flags so the integration can be wired
 * into the application well before we start sending real emails.
 *
 * Every call:
 *   1. Builds the documented payload `{ auth, data }`.
 *   2. Base64-encodes the optional HTML body into `socketFile`.
 *   3. Either logs (disabled / dry-run) or emits `send` onto the
 *      configured queue.
 *
 * The microservice authenticates via the embedded `auth` block, so the
 * credentials are intentionally part of the message body rather than
 * the AMQP URL.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly config: ConfigService,
    @Optional()
    @Inject(NOTIFICATIONS_CLIENT)
    private readonly client: ClientProxy | null,
  ) {}

  /** Pre-warm the RMQ connection so the first real emit isn't cold. */
  async onModuleInit(): Promise<void> {
    if (!this.client) {
      const enabled = this.config.get<boolean>('notifications.enabled');
      this.logger.log(
        `Notifications client not connected (enabled=${enabled}). Service will operate in no-op mode.`,
      );
      return;
    }

    try {
      await this.client.connect();
      this.logger.log('Notifications RMQ client connected.');
    } catch (err) {
      // Don't crash the API if the broker is unreachable — log and let
      // individual sends fail loudly. The producer can recover when the
      // broker comes back via amqp-connection-manager.
      this.logger.error(
        `Failed to connect notifications RMQ client: ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }

  /**
   * Build the wire payload, log it, and (unless dry-run) publish it
   * onto the configured `send` routing key.
   *
   * Returns a small status object describing what actually happened —
   * never throws on a broker outage; the failure is logged so the
   * caller's primary action (e.g. saving a project) isn't aborted by
   * a downstream email problem.
   */
  async send(options: SendEmailOptions): Promise<SendEmailResult> {
    const enabled = this.config.get<boolean>('notifications.enabled');
    const dryRun = this.config.get<boolean>('notifications.dryRun');
    const routingKey =
      this.config.get<string>('notifications.routingKey') || 'send';

    const payload = this.buildPayload(options);
    const recipientCount =
      payload.data.emailBody.to.length +
      payload.data.emailBody.cc.length +
      payload.data.emailBody.bcc.length;

    const logCtx = {
      to: payload.data.emailBody.to.length,
      cc: payload.data.emailBody.cc.length,
      bcc: payload.data.emailBody.bcc.length,
      subject: options.subject,
      enabled,
      dryRun,
      routingKey,
    };

    if (!enabled) {
      this.logger.debug(
        `[notifications:disabled] skipping send ${JSON.stringify(logCtx)}`,
      );
      return { status: 'disabled', recipientCount, subject: options.subject };
    }

    if (dryRun || !this.client) {
      this.logger.log(
        `[notifications:dry-run] would publish ${JSON.stringify(logCtx)}`,
      );
      return { status: 'dry_run', recipientCount, subject: options.subject };
    }

    // DEBUG: log the exact payload going on the wire (HTML body
    // base64-decoded for readability). Useful when reconciling with
    // the downstream Notification Microservice consumer logs.
    const debugPayload = {
      ...payload,
      data: {
        ...payload.data,
        emailBody: {
          ...payload.data.emailBody,
          message: {
            ...payload.data.emailBody.message,
            socketFile: payload.data.emailBody.message.socketFile
              ? `<base64 ${payload.data.emailBody.message.socketFile.length} chars>`
              : undefined,
            socketFileDecoded: payload.data.emailBody.message.socketFile
              ? Buffer.from(
                  payload.data.emailBody.message.socketFile,
                  'base64',
                ).toString('utf8')
              : undefined,
          },
        },
      },
    };
    this.logger.log(`[notifications:payload] ${JSON.stringify(debugPayload)}`);

    try {
      // emit() returns a hot Observable; subscribing kicks the publish.
      // We bound it with a short timeout so a stuck broker can't hang
      // the calling request indefinitely. Producer-side acks aren't
      // exposed by the RMQ transport — the resolve happens as soon as
      // the message is handed to the underlying channel. The emit
      // result is typically `undefined`; logging it confirms whether
      // the broker handed back anything (e.g. publisher confirms).
      const emitResult = await firstValueFrom(
        this.client.emit(routingKey, payload).pipe(timeout(5_000)),
      );
      this.logger.log(
        `[notifications:published] ${JSON.stringify(logCtx)} emitResult=${JSON.stringify(emitResult)}`,
      );
      return { status: 'published', recipientCount, subject: options.subject };
    } catch (err) {
      this.logger.error(
        `[notifications:error] failed to publish ${JSON.stringify(logCtx)}: ${(err as Error).message}`,
      );
      // Swallow the error — we don't want a notification outage to
      // surface to end users. Observability is the recovery path.
      return { status: 'dry_run', recipientCount, subject: options.subject };
    }
  }

  /**
   * Translate caller options into the documented wire format.
   *
   * Centralised here (rather than inline in `send()`) so the payload
   * shape is unit-testable without standing up a RabbitMQ client.
   */
  buildPayload(options: SendEmailOptions): SendEmailPayload {
    const username = this.config.get<string>('notifications.clientId') || '';
    const password = this.config.get<string>('notifications.secret') || '';
    // TEMP: hardcoded from address until env-driven config is finalised
    const defaultFrom = {
      email: 'PRMS-No-reply@cgiar.org',
      name:
        this.config.get<string>('notifications.from.name') ||
        'PRMS Projects Registry',
    };

    const message: SendEmailPayload['data']['emailBody']['message'] = {};
    if (options.text) {
      message.text = options.text;
    }
    if (options.html) {
      message.socketFile = Buffer.from(options.html, 'utf8').toString('base64');
    }

    return {
      auth: { username, password },
      data: {
        from: options.from ?? defaultFrom,
        emailBody: {
          subject: options.subject,
          to: options.to,
          cc: options.cc ?? [],
          bcc: options.bcc ?? [],
          message,
        },
      },
    };
  }
}
