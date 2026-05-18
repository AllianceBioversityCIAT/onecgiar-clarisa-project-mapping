/**
 * Injection token for the RabbitMQ ClientProxy that publishes onto the
 * CGIAR Notification Microservice queue. Exported so tests can override
 * it with a mock client.
 *
 * Lives in its own file (not in `notifications.module.ts`) to break a
 * circular import: the service needs the token to declare its injected
 * dependency, and the module needs the service to register it as a
 * provider. Putting the token here means neither file imports the
 * other transitively.
 */
export const NOTIFICATIONS_CLIENT = 'NOTIFICATIONS_CLIENT';
