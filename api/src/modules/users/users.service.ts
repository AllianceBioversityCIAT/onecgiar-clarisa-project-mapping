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
 *
 * `programIds`:
 *  - `undefined` → leave existing memberships untouched (partial update).
 *  - `null` or `[]` → clear all memberships (only valid when the new
 *    role is not `program_rep`; controller enforces this).
 *  - `[a, b, c]` → replace the membership set with this ordered list.
 *    First element becomes `users.program_id`; `sort_order` follows array
 *    index (0, 1, 2, …).
 */
export interface AdminUpdatePayload {
  role?: UserRole | null;
  programId?: number | null;
  programIds?: number[] | null;
  centerIds?: number[] | null;
  isActive?: boolean;
  /**
   * Pre-login only — accepted only while the user has never signed in
   * (`cognito_sub IS NULL`). After first login Cognito sync overwrites
   * these fields on every refresh, so the service rejects edits then.
   */
  firstName?: string;
  lastName?: string;
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
 * A user row enriched with the ordered list of program IDs the user
 * belongs to. The `programIds` array is derived from the `user_programs`
 * junction table ordered by `sort_order ASC` — primary first, then
 * secondaries in user-submitted order.
 *
 * `programs` (the eager-loadable `ManyToMany` relation on {@link User})
 * is also populated and ordered the same way.
 */
export type UserWithProgramIds = User & { programIds: number[] };

/**
 * A user row enriched with both ordered center IDs and ordered program IDs.
 * Returned by `findById`, `findOneWithRelations`, and `findAllWithRelations`.
 */
export type UserWithMemberships = User & {
  centerIds: number[];
  programIds: number[];
};

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
 * Multi-center membership:
 *  - `users.center_id` is preserved as the primary/default center.
 *  - The `user_centers` junction table stores the full ordered set of
 *    memberships. `sort_order = 0` is the primary (mirrors
 *    `users.center_id`); subsequent rows hold secondary memberships in
 *    user-submitted order.
 *  - All mutating methods that touch `user_centers` run inside a
 *    `DataSource.transaction()` so the `users` write and the
 *    `user_centers` writes are atomic — a partial failure rolls back both.
 *
 * Multi-program membership (mirrors the multi-center pattern exactly):
 *  - `users.program_id` is preserved as the primary/default program.
 *  - The `user_programs` junction table stores the full ordered set of
 *    memberships. `sort_order = 0` is the primary (mirrors
 *    `users.program_id`); subsequent rows hold secondary memberships in
 *    user-submitted order.
 *  - All mutating methods that touch `user_programs` run inside the same
 *    `DataSource.transaction()` as the `users` write — atomicity is shared
 *    across both junction tables.
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
   * both `centers` and `programs` relations loaded (ordered by
   * `sort_order ASC`) and derived `centerIds` / `programIds` arrays.
   *
   * Used by the JWT strategy and by any caller that needs the full
   * membership sets in one round-trip.
   *
   * @param id - The user primary key.
   * @returns The matching user (with `centerIds` + `programIds`) or `null`.
   */
  async findById(id: number): Promise<UserWithMemberships | null> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      return null;
    }
    const withCenters = await this.attachOrderedCenters(user);
    return this.attachOrderedPrograms(
      withCenters as User,
    ) as Promise<UserWithMemberships>;
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
   * `centers` (full ordered set) + `programs` (full ordered set) relations
   * loaded, and derived `centerIds` + `programIds` arrays on each row.
   *
   * Approach: three queries.
   *  1. `usersRepository.find()` with all four relations loads the entity
   *     data but not per-junction-row sort_order (TypeORM M2M doesn't
   *     expose join-table columns).
   *  2. A batched query on `user_centers` builds ordered `centerIds`.
   *  3. A batched query on `user_programs` builds ordered `programIds`.
   */
  async findAllWithRelations(): Promise<UserWithMemberships[]> {
    const users = await this.usersRepository.find({
      relations: ['program', 'center', 'centers', 'programs'],
      order: { createdAt: 'DESC' },
    });
    if (users.length === 0) {
      return [];
    }
    const userIds = users.map((u) => u.id);
    const [centerMemberships, programMemberships] = await Promise.all([
      this.loadOrderedMembershipsForUsers(userIds),
      this.loadOrderedProgramMembershipsForUsers(userIds),
    ]);
    return users.map((u) => {
      const withCenters = this.applyOrderToUser(
        u,
        centerMemberships.get(u.id) ?? [],
      );
      return this.applyProgramOrderToUser(
        withCenters as User,
        programMemberships.get(u.id) ?? [],
      ) as UserWithMemberships;
    });
  }

  /**
   * Return a single user with `program`, `center`, `centers`, and `programs`
   * relations loaded (both ordered) and derived `centerIds` + `programIds`.
   *
   * Used after `createUser` so the controller response contains the same
   * hydrated shape as `GET /users` rows — the frontend can append the
   * new row to its table without an extra round-trip.
   */
  async findOneWithRelations(id: number): Promise<UserWithMemberships | null> {
    const user = await this.usersRepository.findOne({
      where: { id },
      relations: ['program', 'center', 'centers', 'programs'],
    });
    if (!user) {
      return null;
    }
    const withCenters = await this.attachOrderedCenters(user);
    return this.attachOrderedPrograms(
      withCenters as User,
    ) as Promise<UserWithMemberships>;
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

    /* Normalize programIds: when programIds is provided, use it.
     * When only legacy programId is provided, treat as [programId] so
     * existing callers without multi-program support still get a
     * user_programs row seeded at sort_order=0.
     * Deduplicate preserving first-occurrence order. */
    const rawProgramIds: number[] = dto.programIds?.length
      ? dto.programIds
      : dto.programId != null
        ? [dto.programId]
        : [];
    const orderedProgramIds = Array.from(new Set(rawProgramIds));
    if (orderedProgramIds.length !== rawProgramIds.length) {
      this.logger.warn(
        `createUser: dropped duplicate programIds — input=${JSON.stringify(
          rawProgramIds,
        )} deduped=${JSON.stringify(orderedProgramIds)}`,
      );
    }
    if (orderedProgramIds.length > 0) {
      await this.assertAllProgramsExist(orderedProgramIds);
    }
    /* The first element is the primary program → mirrors users.program_id. */
    const primaryProgramId = orderedProgramIds[0] ?? dto.programId ?? null;

    /* Persist users + user_centers + user_programs atomically. */
    const savedId = await this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: dto.role ?? null,
        programId: primaryProgramId,
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
      if (orderedProgramIds.length > 0) {
        await this.replaceUserPrograms(manager, saved.id, orderedProgramIds);
      }
      return saved.id;
    });

    /* Reload outside the transaction with the full relation graph. */
    const hydrated = await this.findOneWithRelations(savedId);
    if (!hydrated) {
      /* Defensive: the row was just inserted in the closed transaction
       * — this branch should be unreachable. */
      throw new NotFoundException(`User with ID "${savedId}" not found`);
    }

    /* Audit: snapshot the new user, EXCLUDING cognito_sub (sensitive
     * identity material). */
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
        programIds: {
          before: null,
          after: orderedProgramIds.length > 0 ? [...orderedProgramIds] : null,
        },
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
   * Membership rows in `user_centers` and `user_programs` are intentionally
   * NOT removed — the user can be reactivated later and we want their
   * previous memberships to come back too.
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

    /* Snapshot pre-update values for audit diff. Capture both centerIds
     * and programIds in sort_order BEFORE the write. */
    const [beforeCenterIds, beforeProgramIds] = await Promise.all([
      this.loadOrderedCenterIds(id),
      this.loadOrderedProgramIds(id),
    ]);
    const before = {
      role: user.role ?? null,
      isActive: user.isActive,
      centerId: user.centerId ?? null,
      programId: user.programId ?? null,
      centerIds: beforeCenterIds,
      programIds: beforeProgramIds,
      firstName: user.firstName,
      lastName: user.lastName,
    };

    /* ---- centers -------------------------------------------------------- */
    /* Three input shapes:
     *   undefined → leave memberships untouched (skip junction write).
     *   null / [] → clear memberships entirely (junction wipe + centerId=null).
     *   number[]  → atomic replace with this ordered list (centerId=first).
     */
    const centerIdsProvided = 'centerIds' in updates;
    const rawNextCenterIds: number[] | null = centerIdsProvided
      ? (updates.centerIds ?? null)
      : null;
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

    let nextPrimaryCenterId: number | null = user.centerId ?? null;
    if (willReplaceCenters) {
      nextPrimaryCenterId =
        nextCenterIds && nextCenterIds.length > 0 ? nextCenterIds[0] : null;
    }

    /* ---- programs ------------------------------------------------------- */
    /* Same three-shape contract as centers. */
    const programIdsProvided = 'programIds' in updates;
    const rawNextProgramIds: number[] | null = programIdsProvided
      ? (updates.programIds ?? null)
      : null;
    const nextProgramIds: number[] | null = rawNextProgramIds
      ? Array.from(new Set(rawNextProgramIds))
      : rawNextProgramIds;
    if (
      rawNextProgramIds &&
      nextProgramIds &&
      nextProgramIds.length !== rawNextProgramIds.length
    ) {
      this.logger.warn(
        `updateUser(${id}): dropped duplicate programIds — input=${JSON.stringify(
          rawNextProgramIds,
        )} deduped=${JSON.stringify(nextProgramIds)}`,
      );
    }
    const willReplacePrograms = programIdsProvided;

    if (willReplacePrograms && nextProgramIds && nextProgramIds.length > 0) {
      await this.assertAllProgramsExist(nextProgramIds);
    }

    let nextPrimaryProgramId: number | null = user.programId ?? null;
    if (willReplacePrograms) {
      nextPrimaryProgramId =
        nextProgramIds && nextProgramIds.length > 0 ? nextProgramIds[0] : null;
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
       * derived fields (centerIds, programIds) onto the entity. */
      if ('role' in updates) {
        txUser.role = updates.role ?? null;
      }
      if ('programId' in updates) {
        txUser.programId = updates.programId ?? null;
      }
      if ('isActive' in updates && typeof updates.isActive === 'boolean') {
        txUser.isActive = updates.isActive;
      }
      /* Names are gated above on `cognitoSub === null`. Trim incidental
       * whitespace so a stray space doesn't register as a real diff. */
      if ('firstName' in updates && typeof updates.firstName === 'string') {
        txUser.firstName = updates.firstName.trim();
      }
      if ('lastName' in updates && typeof updates.lastName === 'string') {
        txUser.lastName = updates.lastName.trim();
      }
      if (willReplaceCenters) {
        txUser.centerId = nextPrimaryCenterId;
      }
      if (willReplacePrograms) {
        txUser.programId = nextPrimaryProgramId;
      }

      await manager.save(txUser);
      this.logger.log(
        `Admin updated user ${id}: ${JSON.stringify({
          ...updates,
          centerIds: centerIdsProvided
            ? (nextCenterIds ?? null)
            : '[unchanged]',
          programIds: programIdsProvided
            ? (nextProgramIds ?? null)
            : '[unchanged]',
        })}`,
      );

      /* Atomic replace on center junction table. */
      if (willReplaceCenters) {
        await manager.delete('user_centers', { user_id: id });
        if (nextCenterIds && nextCenterIds.length > 0) {
          await this.replaceUserCenters(manager, id, nextCenterIds);
        }
      }

      /* Atomic replace on program junction table. */
      if (willReplacePrograms) {
        await manager.delete('user_programs', { user_id: id });
        if (nextProgramIds && nextProgramIds.length > 0) {
          await this.replaceUserPrograms(manager, id, nextProgramIds);
        }
      }
    });

    /* Reload with relations + ordered memberships so the response shape
     * matches `GET /users`. */
    const hydrated = await this.findOneWithRelations(id);
    if (!hydrated) {
      /* Defensive: the row exists because we just saved it. */
      throw new NotFoundException(`User with ID "${id}" not found`);
    }

    const hydratedFull = hydrated as UserWithMemberships;

    const after = {
      role: hydratedFull.role ?? null,
      isActive: hydratedFull.isActive,
      centerId: hydratedFull.centerId ?? null,
      programId: hydratedFull.programId ?? null,
      centerIds: hydratedFull.centerIds,
      programIds: hydratedFull.programIds,
      firstName: hydratedFull.firstName,
      lastName: hydratedFull.lastName,
    };

    /* Build the diff payload. Arrays compare by JSON shape so we don't
     * record a no-op when the same list is re-submitted. */
    type AuditDiff = Record<string, { before: unknown; after: unknown }>;
    const changes: AuditDiff = {};
    for (const key of [
      'role',
      'isActive',
      'centerId',
      'programId',
      'firstName',
      'lastName',
    ] as const) {
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
    if (
      willReplacePrograms &&
      JSON.stringify(before.programIds) !== JSON.stringify(after.programIds)
    ) {
      changes.programIds = {
        before: before.programIds,
        after: after.programIds,
      };
    }

    if (Object.keys(changes).length === 0) {
      /* No effective change — skip the audit row. The transaction above
       * is idempotent so this is safe. */
      return hydratedFull;
    }

    /* Pick the most specific action label that fits this update. */
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
      'programId' in changes ||
      'programIds' in changes
    ) {
      action = 'user.reassigned';
    } else if ('firstName' in changes || 'lastName' in changes) {
      action = 'user.profile_updated';
    }

    await this.auditService.record({
      entityType: AuditEntityType.USER,
      entityId: id,
      action,
      changes,
      summary: `Updated user ${hydratedFull.email}`,
    });

    return hydratedFull;
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

  /* ------------------------------------------------------------------ */
  /* Program membership helpers (mirror center equivalents)             */
  /* ------------------------------------------------------------------ */

  /**
   * Verify every id in the array references an existing program.
   *
   * Single batched lookup — cheap and surfaces a clear "Program X not
   * found" message when a row is missing.
   */
  private async assertAllProgramsExist(ids: number[]): Promise<void> {
    const uniqueIds = Array.from(new Set(ids));
    const found = await this.programsRepository.find({
      where: { id: In(uniqueIds) },
      select: ['id'],
    });
    if (found.length === uniqueIds.length) {
      return;
    }
    const foundIds = new Set(found.map((p) => p.id));
    const missing = uniqueIds.find((id) => !foundIds.has(id));
    throw new NotFoundException(`Program with ID "${missing}" not found`);
  }

  /**
   * Insert one `user_programs` row per id with `sort_order = arrayIndex`.
   *
   * Uses a raw INSERT through the transactional manager because TypeORM's
   * M2M QueryBuilder collapses every `sort_order` to 0 on entity-less
   * junctions (known TypeORM bug). The explicit per-row placeholders
   * below sidestep that bug while remaining SQL-injection safe (positional
   * `?` parameters bound to integers only).
   *
   * Caller must have already validated that every id exists and that
   * `orderedProgramIds` is deduplicated.
   */
  private async replaceUserPrograms(
    manager: EntityManager,
    userId: number,
    orderedProgramIds: number[],
  ): Promise<void> {
    const placeholders = orderedProgramIds.map(() => '(?, ?, ?)').join(', ');
    const flatParams = orderedProgramIds.flatMap((pid, i) => [userId, pid, i]);
    await manager.query(
      `INSERT INTO user_programs (user_id, program_id, sort_order) VALUES ${placeholders}`,
      flatParams,
    );
  }

  /**
   * Read `(program_id, sort_order)` tuples for one user, ordered ASC.
   *
   * Used by `findById` and `updateUser` to expose the ordered membership
   * list without round-tripping through the full `programs` relation.
   */
  private async loadOrderedProgramIds(userId: number): Promise<number[]> {
    const rows: Array<{ program_id: number }> = await this.dataSource.query(
      `SELECT program_id FROM user_programs WHERE user_id = ? ORDER BY sort_order ASC`,
      [userId],
    );
    return rows.map((r) => Number(r.program_id));
  }

  /**
   * Read `(user_id, program_id, sort_order)` tuples for a set of users
   * in one query.
   *
   * Used by `findAllWithRelations` to avoid an N+1 on the membership
   * lookup — one batched query produces the data needed to (a) reorder
   * each row's `programs` array and (b) build each row's `programIds`.
   */
  private async loadOrderedProgramMembershipsForUsers(
    userIds: number[],
  ): Promise<Map<number, number[]>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows: Array<{ user_id: number; program_id: number }> =
      await this.dataSource.query(
        `SELECT user_id, program_id, sort_order
         FROM user_programs
         WHERE user_id IN (${userIds.map(() => '?').join(',')})
         ORDER BY user_id, sort_order ASC`,
        userIds,
      );

    const result = new Map<number, number[]>();
    for (const row of rows) {
      const uid = Number(row.user_id);
      const pid = Number(row.program_id);
      const list = result.get(uid);
      if (list) {
        list.push(pid);
      } else {
        result.set(uid, [pid]);
      }
    }
    return result;
  }

  /**
   * Decorate a single user with an ordered `programIds` array and (when
   * the `programs` relation is loaded) reorder that relation to match.
   */
  private async attachOrderedPrograms(
    user: User,
  ): Promise<User & { programIds: number[] }> {
    const programIds = await this.loadOrderedProgramIds(user.id);
    return this.applyProgramOrderToUser(user, programIds);
  }

  /**
   * Decorate many users in one pass, sharing a single batched membership
   * query.
   */
  private async attachOrderedProgramsToMany(
    users: User[],
  ): Promise<Array<User & { programIds: number[] }>> {
    const idsByUser = await this.loadOrderedProgramMembershipsForUsers(
      users.map((u) => u.id),
    );
    return users.map((u) =>
      this.applyProgramOrderToUser(u, idsByUser.get(u.id) ?? []),
    );
  }

  /**
   * Apply the ordered `programIds` to a user. If the `programs` relation
   * is already loaded on the entity, reorder it to match the array
   * (TypeORM does not honour `sort_order` on M2M loads, so we do this
   * ourselves).
   */
  private applyProgramOrderToUser(
    user: User,
    programIds: number[],
  ): User & { programIds: number[] } {
    if (user.programs && user.programs.length > 0) {
      const byId = new Map(user.programs.map((p) => [p.id, p]));
      const orderedPrograms: Program[] = [];
      for (const pid of programIds) {
        const p = byId.get(pid);
        if (p) {
          orderedPrograms.push(p);
        }
      }
      user.programs = orderedPrograms;
    }
    /* Attach the derived field. We cast through unknown to satisfy TS
     * — `programIds` is not a column on the entity, just a derived shape
     * we serialize alongside it. */
    (user as unknown as { programIds: number[] }).programIds = programIds;
    return user as User & { programIds: number[] };
  }
}
