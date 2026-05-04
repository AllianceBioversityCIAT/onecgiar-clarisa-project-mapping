import {
  AuditEntityType,
  AuditEventChanges,
} from '../entities/audit-event.entity';
import { ActorRole } from '../../mappings/enums/actor-role.enum';

/**
 * Internal type definitions for the AuditService API. These are NOT
 * HTTP DTOs — they are not validated by class-validator and never cross
 * the network. Service callers within the application pass these shapes
 * directly. Keep them as pure interfaces so they can be constructed and
 * spread cheaply at call sites.
 */

/**
 * Optional explicit actor block, used when there is no request context
 * (system jobs, scheduled tasks, tests). When omitted, AuditService
 * resolves the actor from `RequestContextService.getUserId()`.
 */
export interface AuditActorOverride {
  /** User row ID, or null for true system actors with no user backing. */
  userId: number | null;
  /** Role to record on the audit row. May be SYSTEM. */
  role: ActorRole;
  /** Pre-computed display name; bypasses the User-table lookup. */
  displayName: string;
  /** Email at the time of the action; null when none applies. */
  email: string | null;
}

/**
 * Input shape accepted by `AuditService.record()`. Designed so the common
 * call site is a 4-line object literal:
 *
 *   await auditService.record({
 *     entityType: AuditEntityType.PROJECT,
 *     entityId: project.id,
 *     action: 'project.metadata_update',
 *     changes,
 *   });
 */
export interface AuditRecordInput {
  /** Discriminator for the entity table that `entityId` resolves against. */
  entityType: AuditEntityType;
  /** Entity row ID; null only for SYSTEM-typed events with no row. */
  entityId: number | null;
  /** Dotted verb identifying the business action, e.g. `user.role_changed`. */
  action: string;
  /** Field-level diff payload. Use `computeChanges()` to build it. */
  changes?: AuditEventChanges | null;
  /** Short human description; truncated to 500 chars at the DB layer. */
  summary?: string | null;
  /** Reason from the actor; required for unit_admin metadata edits. */
  justification?: string | null;
  /**
   * When supplied, bypasses RequestContextService + User lookup and
   * uses these values verbatim. Used by system jobs and tests.
   */
  actorOverride?: AuditActorOverride;
}

/**
 * Filter options accepted by `AuditService.query()`. All fields are
 * optional — defaults applied inside the service: page=1, limit=50,
 * sort='created_at', direction='desc'.
 */
export interface AuditQueryFilters {
  page?: number;
  limit?: number;
  entityType?: AuditEntityType;
  entityId?: number;
  /** Single action verb or list of action verbs (OR-matched). */
  action?: string | string[];
  actorUserId?: number;
  actorRole?: ActorRole;
  /** Inclusive lower bound on `created_at`. */
  from?: Date;
  /** Inclusive upper bound on `created_at`. */
  to?: Date;
  /** Free-text search applied to `summary` and `justification`. */
  search?: string;
  sort?: 'created_at' | 'actor_user_id' | 'action';
  direction?: 'asc' | 'desc';
}
