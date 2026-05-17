import { registerAs } from '@nestjs/config';

/**
 * Notification microservice configuration.
 *
 * The PRMS API publishes email messages onto a CGIAR-shared RabbitMQ broker
 * that fans messages out to the central Messaging microservice. The
 * microservice authenticates each message via the embedded `auth` block
 * (client_id + secret) rather than relying solely on the AMQP URL.
 *
 * Behaviour flags:
 * - `enabled`  — master kill switch. When false, no RabbitMQ client is
 *                created and `send()` is a no-op (used during local dev
 *                and integration work so we never actually email anyone).
 * - `dryRun`   — builds and logs the full payload but skips the actual
 *                `client.emit('send', …)` call. Useful for verifying the
 *                payload shape against the documented schema without
 *                touching the broker.
 */
export default registerAs('notifications', () => ({
  enabled: process.env.NOTIFICATIONS_ENABLED === 'true',
  dryRun: process.env.NOTIFICATIONS_DRY_RUN !== 'false',
  rabbitmqUrl: process.env.RABBITMQ_URL,
  queue: process.env.NOTIFICATIONS_QUEUE || 'notifications_queue',
  routingKey: process.env.NOTIFICATIONS_ROUTING_KEY || 'send',
  clientId: process.env.NOTIFICATIONS_CLIENT_ID,
  secret: process.env.NOTIFICATIONS_SECRET,
  from: {
    email: process.env.NOTIFICATIONS_FROM_EMAIL || 'noreply@cgiar.org',
    name: process.env.NOTIFICATIONS_FROM_NAME || 'PRMS Projects Registry',
  },
}));
