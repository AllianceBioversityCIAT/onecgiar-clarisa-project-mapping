import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { NotificationsService } from './notifications.service';
import { NOTIFICATIONS_CLIENT } from './notifications.constants';

// Re-exported for backwards compatibility with any existing imports of
// `NOTIFICATIONS_CLIENT` from this module. New code should import from
// `./notifications.constants` directly.
export { NOTIFICATIONS_CLIENT };

/**
 * Global module exposing {@link NotificationsService}.
 *
 * The RabbitMQ {@link ClientProxy} is created via a factory so we can
 * skip the connection entirely when `notifications.enabled = false`
 * (local dev / integration work where no broker is available). The
 * factory returns `null` in that case and the service short-circuits
 * its `emit` call.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: NOTIFICATIONS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ClientProxy | null => {
        const enabled = config.get<boolean>('notifications.enabled');
        const url = config.get<string>('notifications.rabbitmqUrl');
        const queue = config.get<string>('notifications.queue');

        if (!enabled || !url) {
          return null;
        }

        return ClientProxyFactory.create({
          transport: Transport.RMQ,
          options: {
            urls: [url],
            queue,
            queueOptions: { durable: true },
            // Producer-only — never wait for a server channel before allowing
            // emits to be queued client-side. amqp-connection-manager handles
            // reconnect transparently.
            noAck: true,
          },
        });
      },
    },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
