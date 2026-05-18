import { Injectable, inject, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { io, Socket } from 'socket.io-client';

import { environment } from '../../../../environments/environment';
import { AuthService } from '../../../core/services/auth.service';

/**
 * Lightweight payload broadcast by the backend after any negotiation
 * mutation. Clients react by re-fetching the consolidated view.
 */
export interface NegotiationUpdatePayload {
  projectId: number;
  reason: string;
  at: string;
}

/**
 * Realtime client for the consolidated negotiation page.
 *
 * Connects to the NestJS Socket.IO gateway (`/ws/negotiation`) using the
 * current access token, joins a per-project room, and forwards
 * `negotiation:updated` events to subscribers via {@link updates$}.
 *
 * Designed for one active room at a time — the consolidated page only
 * shows one project, so calling {@link joinProject} with a new ID
 * automatically leaves the previous one.
 */
@Injectable({ providedIn: 'root' })
export class NegotiationSocketService implements OnDestroy {
  private readonly authService = inject(AuthService);

  private socket: Socket | null = null;
  private currentProjectId: number | null = null;

  /**
   * Stream of `negotiation:updated` payloads for the room the client
   * has currently joined. Multicasts to every page-level subscriber
   * (so concurrent panes see the same ping).
   */
  private readonly updates = new Subject<NegotiationUpdatePayload>();
  readonly updates$ = this.updates.asObservable();

  /**
   * Connects (if needed) and joins the per-project room.
   *
   * Idempotent: re-calling with the same projectId is a no-op; calling
   * with a new projectId leaves the prior room before joining the new
   * one. Fails silently if no access token is available — callers
   * should retry after auth completes.
   */
  joinProject(projectId: number): void {
    const token = this.authService.getAccessToken();
    if (!token) return;

    if (this.currentProjectId === projectId && this.socket?.connected) {
      return;
    }

    this.ensureSocket(token);

    // Leave any prior room first.
    if (this.currentProjectId !== null && this.currentProjectId !== projectId && this.socket) {
      this.socket.emit('leaveProject', { projectId: this.currentProjectId });
    }

    this.currentProjectId = projectId;

    const join = (): void => {
      this.socket?.emit('joinProject', { projectId });
    };

    if (this.socket?.connected) {
      join();
    } else {
      this.socket?.once('connect', join);
    }
  }

  /**
   * Leaves the current project room and disconnects the socket.
   * Called from `ngOnDestroy` of the consolidated page.
   */
  leaveProject(): void {
    if (this.socket && this.currentProjectId !== null) {
      this.socket.emit('leaveProject', { projectId: this.currentProjectId });
    }
    this.currentProjectId = null;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  ngOnDestroy(): void {
    this.leaveProject();
    this.updates.complete();
  }

  /**
   * Lazily creates the socket.io connection. The auth token is sent on
   * the handshake; the gateway verifies it before allowing the
   * connection to stay open.
   */
  private ensureSocket(token: string): void {
    if (this.socket) {
      // If the token rotated since last connect, refresh it on the
      // existing socket so the next reconnect uses the new value.
      this.socket.auth = { token };
      if (!this.socket.connected) {
        this.socket.connect();
      }
      return;
    }

    // Resolve the WS endpoint. In dev `environment.apiUrl` points at the
    // API host directly (`http://localhost:3000`). In prod `apiUrl` is
    // `/api` for REST traffic, but the WebSocket handshake goes through
    // nginx's separate `/ws/` location — so we anchor on the page origin
    // and let the `path` option below pin the actual Socket.IO endpoint
    // (`/ws/socket.io`).
    const url = environment.production ? window.location.origin : environment.apiUrl;

    this.socket = io(`${url}/negotiation`, {
      // Must match the gateway's `path` option. Anything else and the
      // handshake hits the wrong nginx location (or the wrong service).
      path: '/ws/socket.io',
      // Allow polling fallback so a failed WS upgrade (proxy quirk,
      // mixed-content, corporate firewall) degrades gracefully instead
      // of silently retrying forever.
      transports: ['websocket', 'polling'],
      auth: { token },
      withCredentials: true,
      // Sensible reconnect defaults: don't hammer the server while the
      // backend is down, but keep trying so a brief blip recovers
      // without forcing the user to refresh.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    this.socket.on('negotiation:updated', (payload: NegotiationUpdatePayload) => {
      this.updates.next(payload);
    });

    // Re-join the current room automatically after a reconnect, so the
    // page does not need to know about transient disconnects.
    this.socket.on('connect', () => {
      if (this.currentProjectId !== null) {
        this.socket?.emit('joinProject', { projectId: this.currentProjectId });
      }
    });
  }
}
