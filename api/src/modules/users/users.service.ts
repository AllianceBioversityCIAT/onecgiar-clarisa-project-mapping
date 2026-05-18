import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UserRole } from './enums/user-role.enum';
import { CreateUserDto } from './dto/create-user.dto';
import { Program } from '../reference-data/entities/program.entity';
import { Center } from '../reference-data/entities/center.entity';
import { AuditService } from '../audit/audit.service';
import { AuditEntityType } from '../audit/entities/audit-event.entity';

/**
 * Payload accepted by {@link UsersService.upsertFromCognito}.
 */
export interface CognitoUpsertPayload {
  cognitoSub: string;
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * Fields an administrator can update on a user record.
 *
 * `centerIds`:
 *  - `undefined` → leave existing memberships untouched (partial update).
 *  - `null` or `[]` → clear all memberships (only valid when the new
 *    role is not `center_rep`; controller enforces this).
 *  - `[a, b, c]` → replace the membership set with this ordered list.
 *    First element becomes `users.center_id`; `sort_order` follows array
 *    index (0, 1, 2, …).
 */
export interface AdminUpdatePayload {
  role?: UserRole | null;
  programId?: number | null;
  centerIds?: number[] | null;
  isActive?: boolean;
}

/**
 * A user row enriched with the ordered list of center IDs the user
 * belongs to. The `centerIds` array is derived from the `user_centers`
 * junction table ordered by `sort_order ASC` — primary first, then
 * secondaries in user-submitted order.
 *
 * `centers` (the eager-loadable `ManyToMany` relation on {@link User})
 * is also populated and ordered the same way.
 */
export type UserWithCenterIds = User & { centerIds: number[] };

/**
 * Service responsible for user CRUD operations.
 *
 * Users can enter the system through two paths:
 *  1. Admin pre-provisioning — `createUser` inserts a row with
 *     `cognitoSub = null` keyed on the person's email. On that user's
 *     first Cognito login, `upsertFromCognito` matches them by email
 *     and backfills `cognitoSub`.
 *  2. Direct Cognito login — `upsertFromCognito` creates a fresh record
 *     if no pre-provisioned row exists.
 *
 * Roles are never sourced from Cognito; an administrator assigns them
 * via `updateUser` (or on `createUser`) after the record exists.
 *
 * Multi-center membership (task A-3 of the multi-center plan):
 *  - `users.center_id` is preserved as the primary/default center.
 *  - The `user_centers` junction table stores the full ordered set of
 *    memberships. `sort_order = 0` is the primary (mirrors
 *    `users.center_id`); subsequent rows hold secondary memberships in
 *    user-submitted order.
 *  - All mutating methods that touch `user_centers` run inside a
 *    `DataSource.transaction()` so the `users` write and the
 *    `user_centers` writes are atomic — a partial failure rolls back
 *    both.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Program)
    private readonly programsRepository: Repository<Program>,
    @InjectRepository(Center)
    private readonly centersRepository: Repository<Center>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Find a user by their AWS Cognito `sub` identifier.
   *
   * @param sub - The Cognito `sub` claim value.
   * @returns The matching user or `null` if not found.
   */
  async findByCognitoSub(sub: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { cognitoSub: sub } });
  }

  /**
   * Find a user by their internal integer ID, returning the row with
   * the `centers` relation loaded (ordered by `sort_order ASC`) and a
   * derived `centerIds` array on the result.
   *
   * Used by the JWT strategy (task A-4 of the multi-center plan) and by
   * any caller that needs the full membership set in one round-trip.
   *
   * @param id - The user primary key.
   * @returns The matching user (with `centerIds`) or `null` if not found.
   */
  async findById(id: number): Promise<UserWithCenterIds | null> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      return null;
    }
    return this.attachOrderedCenters(user);
  }

  /**
   * Return all users in the system (no relations, no ordering on
   * memberships). Callers that need `centerIds` should use
   * {@link findAllWithRelations} instead.
   */
  async findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  /**
   * Return all users with their `program` + `center` (primary) +
   * `centers` (full ordered set) relations loaded and a derived
   * `centerIds` array on each row.
   *
   * Approach: two queries.
   *  1. `usersRepository.find()` with `program` + `center` + `centers`
   *     loads everything we need EXCEPT the per-junction-row sort_order
   *     (TypeORM M2M doesn't expose join-table columns).
   *  2. A single batched query on `user_centers` for all loaded user IDs
   *     gives us `(user_id, center_id, sort_order)` tuples, which we
   *     use to (a) reorder each row's `centers` array and (b) build the
   *     `centerIds` array in `sort_order ASC`.
   *
   * Two queries is intentional: cheaper than re-doing the relation via
   * QueryBuilder with `leftJoinAndMapMany`, and the `user_centers` table
   * is tiny (composite PK + sort_order column).
   */
  async findAllWithRelations(): Promise<UserWithCenterIds[]> {
    const users = await this.usersRepository.find({
      relations: ['program', 'center', 'centers'],
      order: { createdAt: 'DESC' },
    });
    if (users.length === 0) {
      return [];
    }
    return this.attachOrderedCentersToMany(users);
  }

  /**
   * Return a single user with `program`, `center`, `centers` relations
   * loaded (centers ordered) and a derived `centerIds`.
   *
   * Used after `createUser` so the controller response contains the same
   * hydrated shape as `GET /users` rows — the frontend can append the
   * new row to its table without an extra round-trip.
   */
  async findOneWithRelations(id: number): Promise<UserWithCenterIds | null> {
    const user = await this.usersRepository.findOne({
      where: { id },
      relations: ['program', 'center', 'centers'],
    });
    if (!user) {
      return null;
    }
    return this.attachOrderedCenters(user);
  }

  /**
   * Create a user record on first Cognito login, or update the email and
   * name fields if the user already exists.
   *
   * Resolution order:
   *  1. Match by `cognitoSub` — normal "returning user" path.
   *  2. Fall back to email match. Two sub-cases:
   *     a. The matched row has `cognitoSub = null` (admin pre-provisioned)
   *        → backfill the sub via `repo.save()`, keep the admin-entered
   *        `firstName`/`lastName`/`role` intact (admin's version wins).
   *     b. The matched row has a different non-null `cognitoSub`
   *        → return the existing row UNCHANGED. This is the "no account
   *        takeover" rule: we must never let a new Cognito identity
   *        hijack an existing user's record just because the email
   *        happens to match.
   *  3. No match anywhere → create a fresh row.
   *
   * This method intentionally does **not** set the `role` field on the
   * create path — role assignment is an admin-only action performed via
   * `createUser` or `updateUser`. It also does NOT touch `user_centers`
   * — a Cognito-provisioned user starts with no center memberships;
   * an admin assigns them via `createUser` / `updateUser` afterwards.
   *
   * @param payload - Cognito token claims (sub, email, first/last name).
   * @returns The created, updated, or existing user entity.
   */
  async upsertFromCognito(payload: CognitoUpsertPayload): Promise<User> {
    const { cognitoSub, email, firstName, lastName } = payload;

    /* 1. Preferred path — match by cognito sub. */
    const userBySub = await this.findByCognitoSub(cognitoSub);

    if (userBySub) {
      userBySub.email = email;
      userBySub.firstName = firstName;
      userBySub.lastName = lastName;
      const saved = await this.usersRepository.save(userBySub);
      this.logger.log(`Updated existing user from Cognito: ${saved.id}`);
      return saved;
    }

    /* 2. Fall back to email match — covers pre-provisioned rows and
     *    identity-path mismatches (dev-login sentinel sub, etc.). */
    const userByEmail = await this.usersRepository.findOne({
      where: { email },
    });

    if (userByEmail) {
      if (userByEmail.cognitoSub == null) {
        /* 2a. Pre-provisioned row — backfill the Cognito sub.
         *
         * Admin-entered firstName/lastName are preserved on purpose:
         * the admin typed them for a reason and they may differ from
         * what Cognito returns (e.g. admin used a preferred name).
         * The email is already correct by construction (we just
         * matched on it). */
        userByEmail.cognitoSub = cognitoSub;
        const saved = await this.usersRepository.save(userByEmail);
        this.logger.log(
          `Backfilled cognito_sub on pre-provisioned user: ${saved.id}`,
        );
        return saved;
      }

      /* 2b. Email match but a different, non-null sub already exists on
       *    the row — this is a potential account-takeover attempt. Do
       *    NOT write to the record. Return it unchanged so the caller
       *    still gets a valid user object; downstream auth will either
       *    let them in as that existing user (same email, same person,
       *    new identity provider) or fail gracefully. */
      this.logger.warn(
        `Cognito login for email ${email} resolved to user ${userByEmail.id} ` +
          `whose stored cognito_sub differs from the incoming sub — returning ` +
          `existing record unchanged (no takeover).`,
      );
      return userByEmail;
    }

    /* 3. No match by sub or by email — create a fresh record. */
    const created = this.usersRepository.create({
      cognitoSub,
      email,
      firstName,
      lastName,
    });
    const saved = await this.usersRepository.save(created);
    this.logger.log(`Created new user from Cognito: ${saved.id}`);
    return saved;
  }

  /**
   * Admin-initiated user creation — pre-provision a new user by email.
   *
   * The record is saved with `cognitoSub = null`. On the user's first
   * Cognito login, `upsertFromCognito` matches them by email and
   * backfills `cognitoSub`. See class-level comment for details.
   *
   * Atomicity: when `centerIds` is provided, the `users` insert AND the
   * `user_centers` inserts happen inside a single `dataSource.transaction`.
   * A partial failure (e.g. duplicate junction row) rolls back the
   * `users` row too — there will never be a half-created user.
   *
   * @param dto - Create-user payload (email, names, optional role +
   *              program/centerIds association, optional isActive).
   * @returns The persisted user with `program`, `center`, and ordered
   *          `centers` relations loaded, plus a derived `centerIds`.
   *
   * @throws ConflictException — when a user with the given email already
   *         exists. Email is the only identity hook for pre-provisioning,
   *         so collisions must surface as 409.
   * @throws NotFoundException — when `programId` or any `centerIds[i]`
   *         does not reference an existing row in the reference-data
   *         tables.
   */
  async createUser(dto: CreateUserDto): Promise<UserWithCenterIds> {
    /* Duplicate-email guard. Handled explicitly (rather than relying on
     * the unique constraint) so we can return a user-friendly 409 with a
     * clear message instead of a generic driver error. */
    const existing = await this.usersRepository.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('User with this email already exists');
    }

    /* Verify referenced program exists so we fail fast with a 404
     * instead of bubbling an FK violation from the database layer. */
    if (dto.programId != null) {
      const program = await this.programsRepository.findOne({
        where: { id: dto.programId },
      });
      if (!program) {
        throw new NotFoundException(
          `Program with ID "${dto.programId}" not found`,
        );
      }
    }

    /* Normalize centerIds: empty array is treated as "no memberships".
     * We dedupe while preserving the index of the first occurrence (JS
     * Set keeps insertion order), so `[1, 3, 1]` becomes `[1, 3]` and
     * not `[3, 1]` — the first-position primary-center contract holds.
     * Without this, a duplicate id would crash `replaceUserCenters()`
     * with a PK violation on the `user_centers` junction table. */
    const rawCenterIds = dto.centerIds?.length ? dto.centerIds : [];
    const orderedCenterIds = Array.from(new Set(rawCenterIds));
    if (orderedCenterIds.length !== rawCenterIds.length) {
      this.logger.warn(
        `createUser: dropped duplicate centerIds — input=${JSON.stringify(
          rawCenterIds,
        )} deduped=${JSON.stringify(orderedCenterIds)}`,
      );
    }
    if (orderedCenterIds.length > 0) {
      await this.assertAllCentersExist(orderedCenterIds);
    }
    /* The first element is the primary center → mirrors users.center_id. */
    const primaryCenterId = orderedCenterIds[0] ?? null;

    /* Persist users + user_centers atomically. Even if the junction
     * inserts fail (e.g. a FK race), the users row is rolled back so
     * we never end up with an orphan user lacking expected memberships. */
    const savedId = await this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: dto.role ?? null,
        programId: dto.programId ?? null,
        centerId: primaryCenterId,
        isActive: dto.isActive ?? true,
        cognitoSub: null,
      });
      const saved = await manager.save(user);
      this.logger.log(
        `Admin created pre-provisioned user ${saved.id} <${saved.email}>`,
      );

      if (orderedCenterIds.length > 0) {
        await this.replaceUserCenters(manager, saved.id, orderedCenterIds);
      }
      return saved.id;
    });

    /* Reload outside the transaction with the full relation graph. The
     * separate read is fine: the transaction has committed by the time
     * we get here, so the relations are visible. */
    const hydrated = await this.findOneWithRelations(savedId);
    if (!hydrated) {
      /* Defensive: the row was just inserted in the closed transaction
       * — this branch should be unreachable. */
      throw new NotFoundException(`User with ID "${savedId}" not found`);
    }

    /* Audit: snapshot the new user, EXCLUDING cognito_sub (sensitive
     * identity material). `centerId` stays in the diff for backwards
     * compatibility with existing audit readers; `centerIds` carries
     * the full ordered membership set. */
    await this.auditService.record({
      entityType: AuditEntityType.USER,
      entityId: hydrated.id,
      action: 'user.create',
      summary: `Created user ${hydrated.email}`,
      changes: {
        email: { before: null, after: hydrated.email },
        firstName: { before: null, after: hydrated.firstName },
        lastName: { before: null, after: hydrated.lastName },
        role: { before: null, after: hydrated.role ?? null },
        programId: { before: null, after: hydrated.programId ?? null },
        centerId: { before: null, after: hydrated.centerId ?? null },
        centerIds: {
          before: null,
          after: orderedCenterIds.length > 0 ? [...orderedCenterIds] : null,
        },
        isActive: { before: null, after: hydrated.isActive },
      },
    });

    return hydrated;
  }

  /**
   * Soft-delete (deactivate) a user.
   *
   * This is a deliberate soft delete: `isActive` is flipped to `false`
   * and every history pointer on `projects.created_by`,
   * `project_mappings.submitted_by`, and `project_mappings.reviewed_by`
   * stays intact. The admin can reactivate the same user later via
   * `PATCH /users/:id` with `isActive: true`.
   *
   * An admin may NOT deactivate their own account — allowing it would
   * orphan the admin role in single-admin deployments.
   *
   * Membership rows in `user_centers` are intentionally NOT removed —
   * the user can be reactivated later and we want their previous
   * memberships to come back too.
   *
   * @param id            - Target user id.
   * @param actingUserId  - Currently authenticated admin's id.
   * @throws NotFoundException   — when the target user does not exist.
   * @throws ForbiddenException  — when the admin tries to deactivate
   *                               themselves.
   */
  async softDelete(
    id: number,
    actingUserId: number,
  ): Promise<{ id: number; isActive: false }> {
    const user = await this.usersRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException(`User with ID "${id}" not found`);
    }

    if (id === actingUserId) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }

    await this.usersRepository.update(id, { isActive: false });
    this.logger.log(
      `Admin ${actingUserId} deactivated user ${id} <${user.email}>`,
    );

    /* Audit the deactivation as a state change (true → false) so the
     * audit log surfaces it consistently with PATCH-driven flips. */
    await this.auditService.record({
      entityType: AuditEntityType.USER,
      entityId: id,
      action: 'user.deactivated',
      summary: `Deactivated user ${user.email}`,
      changes: {
        isActive: { before: true, after: false },
      },
    });

    return { id, isActive: false };
  }

  /**
   * Update admin-managed fields on a user record (role, program,
   * centerIds, active status).
   *
   * Membership strategy when `centerIds` is provided:
   *  - "Atomic replace" — DELETE every existing row in `user_centers`
   *    for this user, then INSERT one row per submitted ID with
   *    `sort_order = arrayIndex`. This is preferred over a delta-diff
   *    because the locked design rule is "submission order is the
   *    contract" — re-inserting from scratch guarantees the final
   *    `sort_order` exactly matches the submitted array order.
   *  - `users.center_id` is updated to `centerIds[0]` (or `null` when
   *    the array is empty / null).
   *  - When `centerIds` is `undefined`, memberships are left untouched
   *    (this is a true partial update — e.g. the admin is just flipping
   *    `isActive`).
   *
   * Atomicity: the `users` write and the junction-table writes happen
   * inside a single transaction. A failure midway through rolls back
   * BOTH — we never end up with the primary `center_id` updated but the
   * membership rows mismatched.
   *
   * @param id      - The user ID to update.
   * @param updates - Partial object with fields to change.
   * @returns The updated user entity with relations + ordered centerIds.
   * @throws NotFoundException if no user exists with the given ID OR
   *                            if any referenced center ID is missing.
   */
  async updateUser(
    id: number,
    updates: AdminUpdatePayload,
  ): Promise<UserWithCenterIds> {
    /* Load the user with its current `centers` relation so we can
     * compute the audit diff and know the prior membership list. */
    const user = await this.usersRepository.findOne({
      where: { id },
      relations: ['centers'],
    });

    if (!user) {
      throw new NotFoundException(`User with ID "${id}" not found`);
    }

    /* Snapshot pre-update values for audit diff. We capture centerIds in
     * sort_order BEFORE the write so we can compare against the new
     * order accurately. */
    const beforeCenterIds = await this.loadOrderedCenterIds(id);
    const before = {
      role: user.role ?? null,
      isActive: user.isActive,
      centerId: user.centerId ?? null,
      programId: user.programId ?? null,
      centerIds: beforeCenterIds,
    };

    /* Determine whether centerIds participates in this update. We treat
     * three input shapes:
     *   undefined → leave memberships untouched (skip junction write).
     *   null / [] → clear memberships entirely (junction wipe + centerId=null).
     *   number[]  → atomic replace with this ordered list (centerId=first).
     */
    const centerIdsProvided = 'centerIds' in updates;
    const rawNextCenterIds: number[] | null = centerIdsProvided
      ? (updates.centerIds ?? null)
      : null;
    /* Dedupe while preserving the index of the first occurrence so the
     * first-position primary-center contract holds (JS Set keeps
     * insertion order). Without this a duplicate id crashes the
     * junction INSERT on the (user_id, center_id) PK. We log a warning
     * so silent dedupe is at least observable in production logs. */
    const nextCenterIds: number[] | null = rawNextCenterIds
      ? Array.from(new Set(rawNextCenterIds))
      : rawNextCenterIds;
    if (
      rawNextCenterIds &&
      nextCenterIds &&
      nextCenterIds.length !== rawNextCenterIds.length
    ) {
      this.logger.warn(
        `updateUser(${id}): dropped duplicate centerIds — input=${JSON.stringify(
          rawNextCenterIds,
        )} deduped=${JSON.stringify(nextCenterIds)}`,
      );
    }
    const willReplaceCenters = centerIdsProvided;

    if (willReplaceCenters && nextCenterIds && nextCenterIds.length > 0) {
      await this.assertAllCentersExist(nextCenterIds);
    }

    /* Compute the next primary center id. When centerIds is undefined
     * we preserve the existing primary; when it's null/[] we clear it;
     * when it's a non-empty list we take the first element. */
    let nextPrimaryCenterId: number | null = user.centerId ?? null;
    if (willReplaceCenters) {
      nextPrimaryCenterId =
        nextCenterIds && nextCenterIds.length > 0 ? nextCenterIds[0] : null;
    }

    await this.dataSource.transaction(async (manager) => {
      /* Re-fetch the user inside the transaction so any concurrent
       * mutation surfaces as a save() conflict rather than a stale
       * write. Then apply scalar updates from the DTO. */
      const txUser = await manager.findOne(User, { where: { id } });
      if (!txUser) {
        throw new NotFoundException(`User with ID "${id}" not found`);
      }

      /* Apply scalar updates explicitly so we don't accidentally write
       * `centerIds` (a non-column) onto the entity. */
      if ('role' in updates) {
        txUser.role = updates.role ?? null;
      }
      if ('programId' in updates) {
        txUser.programId = updates.programId ?? null;
      }
      if ('isActive' in updates && typeof updates.isActive === 'boolean') {
        txUser.isActive = updates.isActive;
      }
      if (willReplaceCenters) {
        txUser.centerId = nextPrimaryCenterId;
      }

      await manager.save(txUser);
      this.logger.log(
        `Admin updated user ${id}: ${JSON.stringify({
          ...updates,
          /* Stringify `centerIds` succinctly to keep log lines short. */
          centerIds: centerIdsProvided
            ? (nextCenterIds ?? null)
            : '[unchanged]',
        })}`,
      );

      /* Atomic replace on the junction table. We always wipe then
       * re-insert when the caller supplied centerIds — keeps submission
       * order intact and avoids ordering bugs from delta diffs. */
      if (willReplaceCenters) {
        await manager.delete('user_centers', { user_id: id });
        if (nextCenterIds && nextCenterIds.length > 0) {
          await this.replaceUserCenters(manager, id, nextCenterIds);
        }
      }
    });

    /* Reload with relations + ordered centers so the response shape
     * matches `GET /users`. */
    const hydrated = await this.findOneWithRelations(id);
    if (!hydrated) {
      /* Defensive: the row exists because we just saved it. */
      throw new NotFoundException(`User with ID "${id}" not found`);
    }

    const after = {
      role: hydrated.role ?? null,
      isActive: hydrated.isActive,
      centerId: hydrated.centerId ?? null,
      programId: hydrated.programId ?? null,
      centerIds: hydrated.centerIds,
    };

    /* Build the diff payload. Arrays compare by JSON shape so we don't
     * record a no-op when the same list is re-submitted. */
    type AuditDiff = Record<string, { before: unknown; after: unknown }>;
    const changes: AuditDiff = {};
    for (const key of ['role', 'isActive', 'centerId', 'programId'] as const) {
      if (before[key] !== after[key]) {
        changes[key] = { before: before[key], after: after[key] };
      }
    }
    if (
      willReplaceCenters &&
      JSON.stringify(before.centerIds) !== JSON.stringify(after.centerIds)
    ) {
      changes.centerIds = {
        before: before.centerIds,
        after: after.centerIds,
      };
    }

    if (Object.keys(changes).length === 0) {
      /* No effective change — skip the audit row. The transaction above
       * is idempotent so this is safe. */
      return hydrated;
    }

    /* Pick the most specific action label that fits this update. Order
     * matters: a single PATCH that flips role + isActive will record the
     * role_changed action because role is the more meaningful event. */
    let action = 'user.update';
    if ('role' in changes) {
      action = 'user.role_changed';
    } else if ('isActive' in changes) {
      const wasActive = before.isActive;
      const nowActive = after.isActive;
      if (wasActive && !nowActive) {
        action = 'user.deactivated';
      } else if (!wasActive && nowActive) {
        action = 'user.reactivated';
      }
    } else if (
      'centerId' in changes ||
      'centerIds' in changes ||
      'programId' in changes
    ) {
      action = 'user.reassigned';
    }

    await this.auditService.record({
      entityType: AuditEntityType.USER,
      entityId: id,
      action,
      changes,
      summary: `Updated user ${hydrated.email}`,
    });

    return hydrated;
  }

  /* ------------------------------------------------------------------ */
  /* Internal helpers                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Verify every id in the array references an existing center.
   *
   * We do this with a single batched lookup rather than N individual
   * queries: cheaper and lets us produce a clear "Center X not found"
   * message when a row is missing.
   */
  private async assertAllCentersExist(ids: number[]): Promise<void> {
    /* Deduplicate to avoid spurious "missing center" errors when the
     * caller (or a buggy frontend) sends the same id twice. */
    const uniqueIds = Array.from(new Set(ids));
    const found = await this.centersRepository.find({
      where: { id: In(uniqueIds) },
      select: ['id'],
    });
    if (found.length === uniqueIds.length) {
      return;
    }
    const foundIds = new Set(found.map((c) => c.id));
    const missing = uniqueIds.find((id) => !foundIds.has(id));
    throw new NotFoundException(`Center with ID "${missing}" not found`);
  }

  /**
   * Insert one `user_centers` row per id with `sort_order = arrayIndex`.
   *
   * Uses a raw INSERT through the transactional manager because the
   * junction table is not bound to a TypeORM entity — TypeORM's M2M
   * relation manages joins through metadata, not a Repository, and we
   * need explicit control over the `sort_order` column anyway.
   *
   * Caller must have already validated that every id exists.
   */
  private async replaceUserCenters(
    manager: EntityManager,
    userId: number,
    orderedCenterIds: number[],
  ): Promise<void> {
    /* Build a single multi-row INSERT — one DB round-trip regardless of
     * how many centers were submitted. We use a raw parameterised query
     * via `manager.query()` rather than QueryBuilder, because TypeORM
     * has no entity metadata for the raw `user_centers` junction table:
     * its multi-row VALUES path then silently reuses row[0]'s template
     * for every subsequent row, which collapses every `sort_order` to 0
     * and breaks the "primary first" ordering contract. The explicit
     * column list + per-row placeholders below sidestep that bug while
     * remaining SQL-injection safe (positional `?` parameters bound to
     * integers only). `created_at` is intentionally omitted — it has a
     * `DEFAULT CURRENT_TIMESTAMP(6)` so MySQL fills it in. */
    const placeholders = orderedCenterIds.map(() => '(?, ?, ?)').join(', ');
    const flatParams = orderedCenterIds.flatMap((cid, i) => [userId, cid, i]);
    await manager.query(
      `INSERT INTO user_centers (user_id, center_id, sort_order) VALUES ${placeholders}`,
      flatParams,
    );
  }

  /**
   * Read `(center_id, sort_order)` tuples for one user, ordered ASC.
   *
   * Used by `findById` and `updateUser` to expose the ordered membership
   * list without round-tripping through the full `centers` relation.
   */
  private async loadOrderedCenterIds(userId: number): Promise<number[]> {
    const rows: Array<{ center_id: number }> = await this.dataSource.query(
      `SELECT center_id FROM user_centers WHERE user_id = ? ORDER BY sort_order ASC`,
      [userId],
    );
    return rows.map((r) => Number(r.center_id));
  }

  /**
   * Read `(user_id, center_id, sort_order)` tuples for a set of users
   * in one query.
   *
   * Used by `findAllWithRelations` to avoid an N+1 on the membership
   * lookup — one batched query produces the data needed to (a) reorder
   * each row's `centers` array and (b) build each row's `centerIds`.
   */
  private async loadOrderedMembershipsForUsers(
    userIds: number[],
  ): Promise<Map<number, number[]>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows: Array<{ user_id: number; center_id: number }> =
      await this.dataSource.query(
        `SELECT user_id, center_id, sort_order
         FROM user_centers
         WHERE user_id IN (${userIds.map(() => '?').join(',')})
         ORDER BY user_id, sort_order ASC`,
        userIds,
      );

    /* Group ordered center_ids per user. Because we sorted by user_id +
     * sort_order, the array we build per user is already in correct
     * order. */
    const result = new Map<number, number[]>();
    for (const row of rows) {
      const uid = Number(row.user_id);
      const cid = Number(row.center_id);
      const list = result.get(uid);
      if (list) {
        list.push(cid);
      } else {
        result.set(uid, [cid]);
      }
    }
    return result;
  }

  /**
   * Decorate a single user with an ordered `centerIds` array and (when
   * the `centers` relation is loaded) reorder that relation to match.
   */
  private async attachOrderedCenters(user: User): Promise<UserWithCenterIds> {
    const centerIds = await this.loadOrderedCenterIds(user.id);
    return this.applyOrderToUser(user, centerIds);
  }

  /**
   * Decorate many users in one pass, sharing a single batched membership
   * query.
   */
  private async attachOrderedCentersToMany(
    users: User[],
  ): Promise<UserWithCenterIds[]> {
    const idsByUser = await this.loadOrderedMembershipsForUsers(
      users.map((u) => u.id),
    );
    return users.map((u) =>
      this.applyOrderToUser(u, idsByUser.get(u.id) ?? []),
    );
  }

  /**
   * Apply the ordered `centerIds` to a user. If the `centers` relation
   * is already loaded on the entity, reorder it to match the array
   * (TypeORM does not honour `sort_order` on M2M loads, so we do this
   * ourselves).
   */
  private applyOrderToUser(user: User, centerIds: number[]): UserWithCenterIds {
    if (user.centers && user.centers.length > 0) {
      const byId = new Map(user.centers.map((c) => [c.id, c]));
      const orderedCenters: Center[] = [];
      for (const cid of centerIds) {
        const c = byId.get(cid);
        if (c) {
          orderedCenters.push(c);
        }
      }
      user.centers = orderedCenters;
    }
    /* Attach the derived field. We cast through unknown to satisfy TS
     * — `centerIds` is not a column on the entity, just a derived shape
     * we serialize alongside it. */
    (user as unknown as { centerIds: number[] }).centerIds = centerIds;
    return user as UserWithCenterIds;
  }
}
