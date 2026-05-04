import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import {
  AuditEntityType,
  AuditEvent,
  AuditEventChanges,
} from './entities/audit-event.entity';
import { ActorRole } from '../mappings/enums/actor-role.enum';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { RequestContextService } from '../../common/context/request-context.service';
import {
  AuditQueryFilters,
  AuditRecordInput,
} from './dto/audit-record-input';

/**
 * Maximum serialised size of a single field's before/after pair before we
 * truncate it. Set well below the JSON column's practical safe size to
 * keep individual rows small enough to render in the UI without paging.
 */
const MAX_CHANGE_FIELD_BYTES = 10 * 1024;

/** Maximum page size accepted by `query()`. */
const MAX_PAGE_LIMIT = 200;

/** Default page size when caller omits `limit`. */
const DEFAULT_PAGE_LIMIT = 50;

/**
 * Sentinel value stored in place of an oversize change payload. The UI
 * is expected to render this verbatim — it's a string so it round-trips
 * cleanly through JSON.
 */
const TRUNCATED_SENTINEL = '<truncated>';

/**
 * Central audit-event recorder + query service. All audit writes from
 * application code MUST go through `record()` — direct repository writes
 * bypass the actor-resolution and error-swallowing safety nets.
 *
 * Reads are served by `query()` and `findOne()`, both of which apply
 * role-based visibility scoping before returning rows.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditEvent)
    private readonly auditRepo: Repository<AuditEvent>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly requestContext: RequestContextService,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  // record()
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Persist a single audit event.
   *
   * Failure-mode contract: this method NEVER throws. Audit logging is a
   * cross-cutting concern — letting it fail loudly would cause the user's
   * primary action to fail too. Instead, errors are logged at WARN level
   * and the call returns normally. Callers can rely on this and call
   * `record()` from within transactional service methods without wrapping.
   */
  async record(input: AuditRecordInput): Promise<void> {
    try {
      // 1. Resolve the actor — either from the override or from the request context.
      const actor = await this.resolveActor(input);
      if (!actor) {
        // Skip-with-warning paths already logged inside resolveActor.
        return;
      }

      // 2. Pull the request ID if we are inside an HTTP request scope.
      const requestId = this.requestContext.getRequestId() ?? null;

      // 3. Build and persist the row. We set createdAt explicitly here
      //    rather than via @CreateDateColumn so system-driven writes have
      //    a deterministic timestamp.
      const event = this.auditRepo.create({
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorUserId: actor.userId,
        actorRole: actor.role,
        actorDisplayName: actor.displayName,
        actorEmail: actor.email,
        changes: input.changes ?? null,
        summary: input.summary ?? null,
        justification: input.justification ?? null,
        requestId,
        createdAt: new Date(),
      });

      await this.auditRepo.save(event);
    } catch (error: unknown) {
      // Swallow + log. Audit failures must not break the primary request.
      const message =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `audit.record failed for entityType=${input.entityType} action=${input.action}: ${message}`,
      );
    }
  }

  /**
   * Resolve the actor block for a record() call. Returns null if the
   * call should be skipped (no context, missing user, role-less user).
   */
  private async resolveActor(input: AuditRecordInput): Promise<{
    userId: number | null;
    role: ActorRole;
    displayName: string;
    email: string | null;
  } | null> {
    // Explicit override wins: trust the caller. Used by system jobs and tests.
    if (input.actorOverride) {
      return {
        userId: input.actorOverride.userId,
        role: input.actorOverride.role,
        displayName: input.actorOverride.displayName,
        email: input.actorOverride.email,
      };
    }

    // Otherwise pull the user ID from the active request context.
    const userId = this.requestContext.getUserId();
    if (userId === undefined || userId === null) {
      this.logger.warn(
        'audit.record called without request context and no actorOverride; skipping',
      );
      return null;
    }

    // Look up the user. Select only the columns we need so we don't pull
    // soft-sensitive data like cognitoSub into the service layer.
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'email', 'firstName', 'lastName', 'role'],
    });
    if (!user) {
      this.logger.warn(
        `audit.record could not resolve user id=${userId}; skipping`,
      );
      return null;
    }

    // We only audit actions taken by users with an assigned role. Newly
    // signed-up users that haven't been promoted yet shouldn't be able
    // to trigger auditable actions in the first place — this is a
    // belt-and-braces check.
    if (!user.role) {
      this.logger.warn(
        `audit.record skipped: user id=${userId} has no role assigned`,
      );
      return null;
    }

    return {
      userId: user.id,
      role: this.mapUserRoleToActorRole(user.role),
      displayName: this.buildDisplayName(user),
      email: user.email,
    };
  }

  /** Maps a UserRole value onto the matching ActorRole. 1:1 except for SYSTEM (audit-only). */
  private mapUserRoleToActorRole(role: UserRole): ActorRole {
    switch (role) {
      case UserRole.ADMIN:
        return ActorRole.ADMIN;
      case UserRole.UNIT_ADMIN:
        return ActorRole.UNIT_ADMIN;
      case UserRole.WORKFLOW_ADMIN:
        return ActorRole.WORKFLOW_ADMIN;
      case UserRole.CENTER_REP:
        return ActorRole.CENTER_REP;
      case UserRole.PROGRAM_REP:
        return ActorRole.PROGRAM_REP;
      default:
        // Defensive fallthrough — TypeScript catches missing cases at
        // compile time, but if a new role is added without updating this
        // map we surface it loudly rather than silently writing wrong data.
        throw new Error(`Unmapped UserRole value: ${role as string}`);
    }
  }

  /**
   * Build the denormalised display name. Mirrors the SQL fallback chain
   * in migration `1776400000000-AddAuditEventsUnified` so that legacy
   * rows and new rows render identically.
   */
  private buildDisplayName(
    user: Pick<User, 'firstName' | 'lastName' | 'email'>,
  ): string {
    const fullName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    if (fullName) return fullName;
    if (user.email) return user.email;
    return '(unknown)';
  }

  // ──────────────────────────────────────────────────────────────────────
  // computeChanges()
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Compare two snapshots of the same entity over a whitelist of fields
   * and produce a `changes` payload suitable for `record()`.
   *
   * Equality semantics:
   *   - `Date` values compare via `getTime()` (handles instances created
   *     in different timezones).
   *   - Object/array values compare via JSON-stringify round-trip — good
   *     enough for the structured payloads we currently store.
   *   - Everything else uses strict equality.
   *
   * Truncation: any field whose serialised value (before OR after) is
   * larger than `MAX_CHANGE_FIELD_BYTES` is replaced with the string
   * sentinel `<truncated>` to keep audit rows from ballooning. This is a
   * documented trade-off (plan §7) — large blobs are rare and we'd rather
   * record that "something changed" than omit the row entirely.
   *
   * @returns Diff payload, or `null` if no fields changed.
   */
  computeChanges<T extends object>(
    before: T,
    after: T,
    fields: ReadonlyArray<keyof T>,
  ): AuditEventChanges | null {
    const changes: AuditEventChanges = {};

    for (const field of fields) {
      const beforeValue = before[field];
      const afterValue = after[field];

      if (this.valuesEqual(beforeValue, afterValue)) {
        continue;
      }

      // Size-check the serialised pair. We size each side independently
      // because a small "before" with a huge "after" still warrants
      // truncation (and vice versa).
      const beforeOversize = this.isOversize(beforeValue);
      const afterOversize = this.isOversize(afterValue);

      if (beforeOversize || afterOversize) {
        changes[field as string] = {
          before: TRUNCATED_SENTINEL,
          after: TRUNCATED_SENTINEL,
        };
      } else {
        changes[field as string] = {
          before: beforeValue,
          after: afterValue,
        };
      }
    }

    // Empty payload means nothing relevant changed — return null so
    // callers can decide to skip the audit write entirely.
    return Object.keys(changes).length === 0 ? null : changes;
  }

  /** Strict equality with Date and object/array support. */
  private valuesEqual(a: unknown, b: unknown): boolean {
    // Identical primitives or same reference.
    if (a === b) return true;
    // Null/undefined fast-path: if one side is nullish but the other isn't, they differ.
    if (a == null || b == null) return false;
    // Date comparison via timestamp.
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }
    // Structural compare for plain objects/arrays. JSON round-trip is
    // adequate for the shapes we store (no functions, no cyclic refs).
    if (typeof a === 'object' && typeof b === 'object') {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        // If either side can't be serialised, treat as different so the
        // change is recorded. Better noisy than missing.
        return false;
      }
    }
    return false;
  }

  /**
   * Returns true if the value's JSON serialisation exceeds the truncate
   * threshold. Uses Buffer.byteLength so we count bytes, not characters
   * — multi-byte UTF-8 inputs are common (CGIAR center names contain
   * accented characters).
   */
  private isOversize(value: unknown): boolean {
    try {
      const serialised = JSON.stringify(value ?? null);
      return Buffer.byteLength(serialised, 'utf8') > MAX_CHANGE_FIELD_BYTES;
    } catch {
      // Unserialisable values are conservatively treated as oversize so
      // we replace them with the sentinel rather than crash on save.
      return true;
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // query() / findOne()
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Paginated, filtered, role-scoped audit query.
   *
   * Visibility scoping is applied BEFORE user-supplied filters, so an
   * over-eager filter cannot widen what the caller can see. The caller's
   * @Roles guard at the controller layer is the first gate; this method
   * defends behind it.
   */
  async query(
    filters: AuditQueryFilters,
    callerRole: UserRole,
    callerUserId: number,
  ): Promise<{ items: AuditEvent[]; total: number }> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(
      MAX_PAGE_LIMIT,
      Math.max(1, filters.limit ?? DEFAULT_PAGE_LIMIT),
    );
    const sort = filters.sort ?? 'created_at';
    const direction = (filters.direction ?? 'desc').toUpperCase() as
      | 'ASC'
      | 'DESC';

    // Map the camelCase property name onto the raw DB column for ORDER BY.
    // Per CLAUDE.md: orderBy() with QueryBuilder + getManyAndCount() must
    // use raw snake_case column names to avoid the databaseName bug.
    const orderColumn = this.toOrderColumn(sort);

    // No join on actorUser: actor identity is already denormalised onto every
    // audit row (actorDisplayName, actorEmail, actorRole) at write time, so
    // hydrating the live User would be redundant payload + a small leak of
    // unrelated User columns.
    const qb = this.auditRepo.createQueryBuilder('audit');

    // 1. Visibility scope first. Throws ForbiddenException for unsupported roles.
    this.applyVisibilityScope(qb, callerRole, callerUserId);

    // 2. Then user-supplied filters.
    this.applyUserFilters(qb, filters);

    // 3. Pagination. offset/limit instead of skip/take per CLAUDE.md.
    qb.orderBy(orderColumn, direction)
      .offset((page - 1) * limit)
      .limit(limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  /**
   * Single audit row by ID, role-scoped. Returns null when the row does
   * not exist OR when the caller is not allowed to see it — we
   * deliberately do not distinguish, to avoid leaking row existence to
   * unauthorised callers.
   */
  async findOne(
    id: string,
    callerRole: UserRole,
    callerUserId: number,
  ): Promise<AuditEvent | null> {
    // Same rationale as query() — no join on actorUser; denormalised actor
    // fields on the audit row are the source of truth.
    const qb = this.auditRepo
      .createQueryBuilder('audit')
      .where('audit.id = :id', { id });

    this.applyVisibilityScope(qb, callerRole, callerUserId);

    return qb.getOne();
  }

  /**
   * Distinct list of action verbs ever recorded. Used by the admin UI
   * to populate the "Action" filter dropdown without hardcoding values
   * that may shift as we wire new audit call sites.
   */
  async getDistinctActions(): Promise<string[]> {
    const rows: Array<{ action: string }> = await this.auditRepo.query(
      'SELECT DISTINCT action FROM audit_events ORDER BY action ASC',
    );
    return rows.map((r) => r.action);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internal query helpers
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Apply role-based visibility scoping to a QueryBuilder.
   *
   * - `ADMIN`           → no scope (full visibility).
   * - `WORKFLOW_ADMIN`  → only project / mapping / snapshot events.
   * - `UNIT_ADMIN`      → events the user authored, plus all
   *                       project.metadata_* events on any project.
   * - All other roles   → ForbiddenException.
   *
   * Extracted into its own method so `query()` and `findOne()` cannot
   * drift apart on visibility rules.
   */
  private applyVisibilityScope(
    qb: SelectQueryBuilder<AuditEvent>,
    callerRole: UserRole,
    callerUserId: number,
  ): void {
    switch (callerRole) {
      case UserRole.ADMIN:
        // Full visibility — no additional WHERE clause.
        return;

      case UserRole.WORKFLOW_ADMIN:
        qb.andWhere('audit.entityType IN (:...wfaEntityTypes)', {
          wfaEntityTypes: [
            AuditEntityType.PROJECT,
            AuditEntityType.PROJECT_MAPPING,
            AuditEntityType.PUBLISHED_SNAPSHOT,
          ],
        });
        return;

      case UserRole.UNIT_ADMIN:
        // Unit admins see (a) anything they personally authored, plus
        // (b) all project metadata events across the system, since
        // they collaborate as a pool on PPU/PCU edits.
        qb.andWhere(
          '(audit.actorUserId = :uaUserId OR (audit.entityType = :uaProject AND audit.action LIKE :uaMetadataPrefix))',
          {
            uaUserId: callerUserId,
            uaProject: AuditEntityType.PROJECT,
            uaMetadataPrefix: 'project.metadata%',
          },
        );
        return;

      default:
        // Controller @Roles guards should prevent us from getting here,
        // but throw defensively so a misconfiguration becomes visible.
        throw new ForbiddenException(
          'Caller role is not permitted to read audit events',
        );
    }
  }

  /**
   * Apply user-supplied (non-scope) filters to the QueryBuilder. Order
   * doesn't matter — these are all AND-combined with the scope clauses.
   */
  private applyUserFilters(
    qb: SelectQueryBuilder<AuditEvent>,
    filters: AuditQueryFilters,
  ): void {
    if (filters.entityType) {
      qb.andWhere('audit.entityType = :entityType', {
        entityType: filters.entityType,
      });
    }

    if (filters.entityId !== undefined && filters.entityId !== null) {
      qb.andWhere('audit.entityId = :entityId', {
        entityId: filters.entityId,
      });
    }

    if (filters.action) {
      // Accept either a single verb or a list. Lists become an IN clause.
      if (Array.isArray(filters.action)) {
        if (filters.action.length > 0) {
          qb.andWhere('audit.action IN (:...actions)', {
            actions: filters.action,
          });
        }
      } else {
        qb.andWhere('audit.action = :action', { action: filters.action });
      }
    }

    if (filters.actorUserId !== undefined && filters.actorUserId !== null) {
      qb.andWhere('audit.actorUserId = :actorUserId', {
        actorUserId: filters.actorUserId,
      });
    }

    if (filters.actorRole) {
      qb.andWhere('audit.actorRole = :actorRole', {
        actorRole: filters.actorRole,
      });
    }

    if (filters.from) {
      qb.andWhere('audit.createdAt >= :fromDate', { fromDate: filters.from });
    }

    if (filters.to) {
      // The date picker sends midnight at the start of the chosen day. Treat
      // `to` as inclusive — roll to end-of-day so a same-day range
      // (from = to = 2026-04-27) returns events authored that day.
      const toEndOfDay = new Date(filters.to);
      if (
        toEndOfDay.getUTCHours() === 0 &&
        toEndOfDay.getUTCMinutes() === 0 &&
        toEndOfDay.getUTCSeconds() === 0 &&
        toEndOfDay.getUTCMilliseconds() === 0
      ) {
        toEndOfDay.setUTCHours(23, 59, 59, 999);
      }
      qb.andWhere('audit.createdAt <= :toDate', { toDate: toEndOfDay });
    }

    if (filters.search) {
      // Strip wildcard chars from user input so a malicious or unaware
      // caller can't expand the LIKE to match everything (e.g. "%").
      const safe = this.escapeLikeWildcards(filters.search.trim());
      if (safe) {
        qb.andWhere(
          '(audit.summary LIKE :searchTerm OR audit.justification LIKE :searchTerm)',
          { searchTerm: `%${safe}%` },
        );
      }
    }
  }

  /**
   * Map the public sort key onto the QueryBuilder-qualified raw DB column.
   * CLAUDE.md mandates raw snake_case column names in `orderBy()` to avoid
   * TypeORM's `databaseName` undefined bug when combined with
   * `getManyAndCount()` — but the prefix must be the QueryBuilder ALIAS
   * (`audit`), not the table name (`audit_events`), because the SELECT
   * uses the alias.
   */
  private toOrderColumn(sort: NonNullable<AuditQueryFilters['sort']>): string {
    switch (sort) {
      case 'created_at':
        return 'audit.created_at';
      case 'actor_user_id':
        return 'audit.actor_user_id';
      case 'action':
        return 'audit.action';
      default:
        // Reachable only if the type narrows incorrectly at the boundary.
        return 'audit.created_at';
    }
  }

  /**
   * Strip MySQL LIKE wildcards (% and _) from user-supplied search
   * terms. We deliberately remove rather than escape — escaping would
   * keep the literal characters in matches, which is rarely what the
   * user wants for a free-text search box.
   */
  private escapeLikeWildcards(input: string): string {
    return input.replace(/[%_\\]/g, '');
  }
}
