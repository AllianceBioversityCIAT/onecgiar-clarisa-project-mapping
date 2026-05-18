import { Logger, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { UsersService } from '../../users/users.service';

/**
 * Authenticated socket — `data.userId` is set during the handshake.
 */
interface AuthSocket extends Socket {
  data: { userId?: number };
}

/**
 * Gateway that powers realtime updates on the consolidated negotiation page.
 *
 * Clients connect with a JWT (passed as `auth.token` on the socket.io
 * handshake) and join a per-project room (`project:<id>`). Whenever a
 * mutation happens on the negotiation, `MappingsService` calls
 * {@link emitProjectUpdate} which broadcasts a lightweight
 * `negotiation:updated` event to every member of the room. The client
 * reacts by re-fetching the consolidated view — keeping all participants
 * eventually consistent without diff bugs.
 */
@WebSocketGateway({
  // Explicit Socket.IO path. Nginx proxies `/ws/*` to the API, so we
  // serve the handshake from `/ws/socket.io/...` instead of the default
  // `/socket.io/...` — this keeps the API behind a single, predictable
  // location block and avoids collisions with the `/api/*` proxy.
  path: '/ws/socket.io',
  namespace: '/negotiation',
  cors: {
    // CORS for the websocket handshake. Wildcards are fine here because
    // we authenticate every connection via JWT before the client can
    // join any room.
    origin: true,
    credentials: true,
  },
})
export class NegotiationGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  private readonly logger = new Logger(NegotiationGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  onModuleInit(): void {
    this.logger.log('NegotiationGateway initialised');
  }

  /**
   * Authenticates the connection. The client must include a JWT in
   * `socket.handshake.auth.token`. Falls back to the `Authorization`
   * header if present so non-browser clients can connect.
   */
  async handleConnection(client: AuthSocket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      this.logger.warn(`Rejected ws connection ${client.id}: missing token`);
      client.disconnect(true);
      return;
    }

    try {
      const secret = this.configService.getOrThrow<string>('auth.jwtSecret');
      const payload = await this.jwtService.verifyAsync<{
        sub: number | string;
      }>(token, { secret });
      const userId = Number(payload.sub);
      if (!Number.isFinite(userId) || userId <= 0) {
        throw new Error('invalid sub');
      }

      const user = await this.usersService.findById(userId);
      if (!user || !user.isActive) {
        throw new Error('user not found or deactivated');
      }

      client.data.userId = userId;
      this.logger.debug(`ws connected: socket=${client.id} user=${userId}`);
    } catch (err) {
      this.logger.warn(
        `Rejected ws connection ${client.id}: ${(err as Error).message}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthSocket): void {
    this.logger.debug(`ws disconnected: socket=${client.id}`);
  }

  /**
   * Client asks to subscribe to updates for a specific project. We don't
   * re-check authorization here — the consolidated REST endpoint is the
   * authoritative source. Joining a room only grants visibility into
   * "something changed" pings; the client still has to re-fetch via
   * the authenticated REST API to actually see anything.
   */
  @SubscribeMessage('joinProject')
  handleJoinProject(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: { projectId: number } | number,
  ): { ok: true; room: string } | { ok: false; error: string } {
    const projectId = typeof data === 'number' ? data : Number(data?.projectId);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return { ok: false, error: 'invalid projectId' };
    }

    // Leave any prior project rooms so a single socket only listens to
    // one project at a time (the page only shows one anyway).
    for (const room of client.rooms) {
      if (room !== client.id && room.startsWith('project:')) {
        client.leave(room);
      }
    }

    const room = `project:${projectId}`;
    client.join(room);
    return { ok: true, room };
  }

  @SubscribeMessage('leaveProject')
  handleLeaveProject(
    @ConnectedSocket() client: AuthSocket,
    @MessageBody() data: { projectId: number } | number,
  ): void {
    const projectId = typeof data === 'number' ? data : Number(data?.projectId);
    if (!Number.isFinite(projectId) || projectId <= 0) return;
    client.leave(`project:${projectId}`);
  }

  /**
   * Broadcasts a `negotiation:updated` event to every client subscribed
   * to the given project. Called by `MappingsService` after any mutation.
   *
   * The payload is intentionally minimal: clients re-fetch the full
   * consolidated view through the authenticated REST endpoint, which
   * guarantees consistent state and authorization.
   */
  emitProjectUpdate(projectId: number, reason: string): void {
    if (!this.server) return;
    this.server.to(`project:${projectId}`).emit('negotiation:updated', {
      projectId,
      reason,
      at: new Date().toISOString(),
    });
  }

  /** Pulls the JWT off the handshake — supports both auth payload and header. */
  private extractToken(client: Socket): string | null {
    const authToken = (client.handshake.auth as { token?: string } | undefined)
      ?.token;
    if (authToken) return authToken;

    const header =
      client.handshake.headers.authorization ??
      (client.handshake.headers as Record<string, string>)['Authorization'];
    if (header && header.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim();
    }
    return null;
  }
}
