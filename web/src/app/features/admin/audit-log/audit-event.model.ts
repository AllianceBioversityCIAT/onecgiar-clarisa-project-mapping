/**
 * Unified audit event as returned by the GET /audit endpoint.
 *
 * One row per logical action (e.g. one save of several fields produces one
 * event with all changed fields packed into the `changes` map). For entity
 * types that do not carry a field-level diff (create, lock, archive, etc.)
 * `changes` will be null and `summary` will carry the human-readable description.
 */
export interface AuditEvent {
  /** BIGINT primary key — returned as a string to avoid JS integer overflow. */
  id: string;

  /** Entity category the action was performed on. */
  entityType:
    | 'project'
    | 'project_mapping'
    | 'user'
    | 'published_snapshot'
    | 'import_run'
    | 'clarisa_sync'
    | 'system';

  /** Primary key of the affected entity; null for system-level events. */
  entityId: number | null;

  /**
   * Machine-readable action identifier.
   * Examples: 'project.update', 'project.metadata_update', 'project.locked',
   * 'project.create', 'project.archive', 'project.reopened',
   * 'project.snapshot_republished', 'user.role_changed'.
   */
  action: string;

  /** User ID of the actor; null for automated / system actions. */
  actorUserId: number | null;

  /** Role the actor held at the time the event was written. */
  actorRole:
    | 'admin'
    | 'center_rep'
    | 'program_rep'
    | 'workflow_admin'
    | 'unit_admin'
    | 'system';

  /**
   * Snapshot of the actor's display name at write-time ("First Last").
   * Preserved so historical rows remain accurate if the user is later renamed.
   */
  actorDisplayName: string;

  /** Snapshot of the actor's email at write-time; null for system actions. */
  actorEmail: string | null;

  /**
   * Field-level diff for update actions.
   * Each key is a camelCase field name; value is `{ before, after }`.
   * Null for non-diff events (create, lock, archive, etc.).
   *
   * @example
   * {
   *   name:        { before: 'Old Title', after: 'New Title' },
   *   totalBudget: { before: '100000.00', after: '120000.00' }
   * }
   */
  changes: Record<string, { before: unknown; after: unknown }> | null;

  /**
   * Human-readable one-liner written by the backend.
   * Present on action types that don't produce a field diff (create, lock, etc.),
   * and sometimes also on diff events for richer context.
   */
  summary: string | null;

  /**
   * Free-text reason supplied by the actor.
   * Required for unit_admin edits; optional for admin edits; null for system events.
   */
  justification: string | null;

  /** The request UUID logged by the backend for correlation with Winston logs. */
  requestId: string | null;

  /** ISO 8601 timestamp of when the event was written. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Query filters
// ---------------------------------------------------------------------------

/**
 * Filter + pagination options accepted by AuditLogService.query().
 * All filter fields are optional; omitted keys are not sent to the API.
 */
export interface AuditLogQueryFilters {
  /** 1-based page number. */
  page?: number;
  /** Rows per page. */
  limit?: number;
  /** Narrow to a single entity category. */
  entityType?: AuditEvent['entityType'];
  /** Narrow to a specific entity instance by its primary key. */
  entityId?: number;
  /**
   * Filter by one or more action strings.
   * Multiple values are OR-combined; passed to the API as a comma-separated string.
   */
  action?: string | string[];
  /** Filter by actor user ID. */
  actorUserId?: number;
  /** Filter by the role the actor held at event time. */
  actorRole?: AuditEvent['actorRole'];
  /**
   * Lower bound on createdAt — ISO 8601 date or datetime string.
   * API performs an inclusive '>=' comparison.
   */
  from?: string;
  /**
   * Upper bound on createdAt — ISO 8601 date or datetime string.
   * API performs an inclusive '<=' comparison.
   */
  to?: string;
  /** Free-text search against summary and justification. */
  search?: string;
  /** Column to sort by (e.g. 'created_at'). */
  sort?: string;
  /** Sort direction. */
  direction?: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

/**
 * Paginated response envelope returned by GET /audit.
 */
export interface AuditLogQueryResponse {
  items: AuditEvent[];
  total: number;
  page: number;
  limit: number;
}
