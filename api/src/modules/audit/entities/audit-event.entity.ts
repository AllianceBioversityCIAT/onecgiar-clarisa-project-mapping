import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ActorRole } from '../../mappings/enums/actor-role.enum';

/**
 * Polymorphic entity types recorded on `audit_events.entity_type`.
 *
 * Each value identifies the table that the audit row's `entity_id` resolves
 * against. `SYSTEM` is for events with no associated row (e.g. a CLARISA
 * sync run, a scheduler tick) — `entity_id` is null on those.
 *
 * Mirrors the DB ENUM defined in migration
 * `1776400000000-AddAuditEventsUnified`.
 */
export enum AuditEntityType {
  PROJECT = 'project',
  PROJECT_MAPPING = 'project_mapping',
  USER = 'user',
  PUBLISHED_SNAPSHOT = 'published_snapshot',
  IMPORT_RUN = 'import_run',
  CLARISA_SYNC = 'clarisa_sync',
  SYSTEM = 'system',
}

/**
 * JSON shape stored on `audit_events.changes`.
 *
 * Keyed by field name; each entry carries the value before and after the
 * change. Exported separately from `AuditEvent` so service / DTO code can
 * type-check change payloads without importing the entity.
 *
 * `unknown` (rather than `any`) is used on the values so callers must
 * narrow before reading — this prevents accidental coercion of arbitrary
 * stored values (e.g. JSON arrays, dates serialised as strings).
 */
export type AuditEventChanges = Record<
  string,
  { before: unknown; after: unknown }
>;

/**
 * Append-only unified audit log row.
 *
 * Each row captures a single business action: who performed it, on what
 * entity, when, and (optionally) which fields changed and why. Rows are
 * never updated or deleted by application code — `synchronize: false` and
 * the absence of an `updated_at` column reflect that.
 *
 * Indexes on the table support the four primary read paths:
 *   1. By entity (entity_type, entity_id, created_at DESC) — "Activity tab"
 *   2. By actor   (actor_user_id, created_at DESC)         — "User history"
 *   3. By action  (action, created_at DESC)                — admin filter
 *   4. By time    (created_at DESC)                        — global feed
 */
@Entity('audit_events')
@Index('idx_audit_entity', ['entityType', 'entityId', 'createdAt'])
@Index('idx_audit_actor', ['actorUserId', 'createdAt'])
@Index('idx_audit_action', ['action', 'createdAt'])
@Index('idx_audit_created_at', ['createdAt'])
export class AuditEvent {
  /**
   * BIGINT primary key. TypeORM returns BIGINT values as strings to avoid
   * JS number-precision loss above 2^53; we type the property as `string`
   * to match runtime behaviour. The DB-side AUTO_INCREMENT generates the
   * value — we never assign it manually.
   */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** Polymorphic discriminator — tells the reader which table `entityId` belongs to. */
  @Column({
    name: 'entity_type',
    type: 'enum',
    enum: AuditEntityType,
  })
  entityType: AuditEntityType;

  /**
   * Foreign-ish reference into the table indicated by `entityType`.
   * Nullable: SYSTEM events (e.g. clarisa_sync.run) have no row to point at.
   * No DB-level FK because the column is polymorphic.
   */
  @Column({ name: 'entity_id', type: 'int', nullable: true })
  entityId: number | null;

  /** Dotted action verb, e.g. `project.metadata_update`, `user.role_changed`. */
  @Column({ name: 'action', type: 'varchar', length: 64 })
  action: string;

  /**
   * The human (or system) actor, denormalised into a User FK plus inline
   * snapshot fields (`actor_display_name`, `actor_email`, `actor_role`)
   * so the audit row remains readable even after the user is renamed,
   * deactivated, or deleted.
   *
   * `onDelete: 'SET NULL'` mirrors the DB constraint — if a user is hard
   * deleted (rare; we soft-deactivate normally), the audit row stays.
   */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_user_id' })
  actorUser: User | null;

  /** Bare FK column. Kept alongside the relation so we can filter without joining. */
  @Column({ name: 'actor_user_id', type: 'int', nullable: true })
  actorUserId: number | null;

  /**
   * Frozen role at the time of the action. May diverge from the user's
   * current `users.role` if an admin reassigns roles after the fact.
   */
  @Column({
    name: 'actor_role',
    type: 'enum',
    enum: ActorRole,
  })
  actorRole: ActorRole;

  /** "First Last" or fallback to email/'(unknown)'. Never null. */
  @Column({ name: 'actor_display_name', type: 'varchar', length: 255 })
  actorDisplayName: string;

  /** Email at the time of the action. NULL for SYSTEM actors. */
  @Column({ name: 'actor_email', type: 'varchar', length: 255, nullable: true })
  actorEmail: string | null;

  /**
   * Field-level change payload. Keyed by field name; each entry carries
   * the prior and posterior values. NULL for actions that don't track
   * field-level diffs (e.g. snapshot.published, clarisa_sync.run).
   */
  @Column({ type: 'json', nullable: true })
  changes: AuditEventChanges | null;

  /** Short human-readable description, e.g. "Edited field: name". */
  @Column({ name: 'summary', type: 'varchar', length: 500, nullable: true })
  summary: string | null;

  /** Reason given by the actor; required by callers for unit_admin metadata edits. */
  @Column({ name: 'justification', type: 'text', nullable: true })
  justification: string | null;

  /**
   * Correlates the audit row with the originating HTTP request via the
   * `X-Request-ID` UUID. NULL for system-driven writes that have no
   * request context.
   */
  @Column({ name: 'request_id', type: 'varchar', length: 64, nullable: true })
  requestId: string | null;

  /**
   * Set explicitly by the service (NOT via `@CreateDateColumn`) so that
   * system-actor writes — which may occur outside any request scope —
   * remain in our control. Stored at millisecond precision (DATETIME(3)).
   */
  @Column({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt: Date;
}
