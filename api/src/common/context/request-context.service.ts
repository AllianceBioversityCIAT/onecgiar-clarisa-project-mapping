import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * Shape of the request-scoped context stored in AsyncLocalStorage.
 */
interface RequestContext {
  /** UUID assigned to the current HTTP request. */
  requestId: string;
  /** Integer ID of the authenticated user (set after auth, may remain undefined). */
  userId?: number;
}

/**
 * Provides request-scoped context via AsyncLocalStorage.
 *
 * This service is registered as a global singleton. Each incoming HTTP request
 * runs within its own AsyncLocalStorage context so that the requestId and
 * userId are available anywhere in the call chain without manual propagation.
 */
@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  /**
   * Execute a callback within a new request context.
   * @param context - Initial context values (at minimum the requestId).
   * @param callback - The function to run inside the context.
   */
  run(context: RequestContext, callback: () => void): void {
    this.storage.run(context, callback);
  }

  /**
   * Retrieve the current request ID from the active context.
   * @returns The request UUID, or undefined if called outside a request scope.
   */
  getRequestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  /**
   * Update the request ID in the active context.
   * @param id - The UUID to set.
   */
  setRequestId(id: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.requestId = id;
    }
  }

  /**
   * Retrieve the authenticated user ID from the active context.
   * @returns The user ID, or undefined if not yet set.
   */
  getUserId(): number | undefined {
    return this.storage.getStore()?.userId;
  }

  /**
   * Update the authenticated user ID in the active context.
   * @param id - The user ID to set.
   */
  setUserId(id: number): void {
    const store = this.storage.getStore();
    if (store) {
      store.userId = id;
    }
  }
}
