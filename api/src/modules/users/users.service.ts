import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
 */
export interface AdminUpdatePayload {
  role?: UserRole | null;
  programId?: number | null;
  centerId?: number | null;
  isActive?: boolean;
}

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
   * Find a user by their internal integer ID.
   *
   * @param id - The user primary key.
   * @returns The matching user or `null` if not found.
   */
  async findById(id: number): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  /**
   * Return all users in the system.
   *
   * @returns An array of all user records.
   */
  async findAll(): Promise<User[]> {
    return this.usersRepository.find();
  }

  /**
   * Return all users with their program and center relations eagerly loaded.
   *
   * Used by the admin user-management endpoint to display association
   * details without additional queries.
   *
   * @returns An array of all user records with relations.
   */
  async findAllWithRelations(): Promise<User[]> {
    return this.usersRepository.find({
      relations: ['program', 'center'],
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Return a single user with `program` and `center` relations loaded.
   *
   * Used after `createUser` so the controller response contains the same
   * hydrated shape as `GET /users` rows — the frontend can append the
   * new row to its table without an extra round-trip.
   */
  async findOneWithRelations(id: number): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { id },
      relations: ['program', 'center'],
    });
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
   * `createUser` or `updateUser`.
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
   * @param dto - Create-user payload (email, names, optional role +
   *              program/center association, optional isActive).
   * @returns The persisted user with `program` and `center` relations
   *          loaded so the frontend can render the new row immediately.
   *
   * @throws ConflictException — when a user with the given email already
   *         exists. Email is the only identity hook for pre-provisioning,
   *         so collisions must surface as 409 (matches the error table
   *         in the design spec).
   * @throws NotFoundException — when `programId` or `centerId` are given
   *         but do not reference an existing row in the reference-data
   *         tables.
   */
  async createUser(dto: CreateUserDto): Promise<User> {
    /* Duplicate-email guard. Handled explicitly (rather than relying on
     * the unique constraint) so we can return a user-friendly 409 with a
     * clear message instead of a generic driver error. */
    const existing = await this.usersRepository.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('User with this email already exists');
    }

    /* Verify referenced program/center exist so we fail fast with a 404
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

    if (dto.centerId != null) {
      const center = await this.centersRepository.findOne({
        where: { id: dto.centerId },
      });
      if (!center) {
        throw new NotFoundException(
          `Center with ID "${dto.centerId}" not found`,
        );
      }
    }

    /* Persist the row. cognitoSub is explicitly null — the migration
     * MakeCognitoSubNullable1775912366569 allows this, and the UNIQUE
     * index on cognito_sub treats multiple NULLs as non-colliding. */
    const user = this.usersRepository.create({
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      role: dto.role ?? null,
      programId: dto.programId ?? null,
      centerId: dto.centerId ?? null,
      isActive: dto.isActive ?? true,
      cognitoSub: null,
    });
    const saved = await this.usersRepository.save(user);
    this.logger.log(
      `Admin created pre-provisioned user ${saved.id} <${saved.email}>`,
    );

    /* Reload with relations so the API response matches `findAll`. A
     * null-forgiving cast is safe here: we just inserted the row. */
    const hydrated = await this.findOneWithRelations(saved.id);

    /* Audit: snapshot the new user, EXCLUDING cognito_sub (sensitive
     * identity material — we don't want it in the audit log payload).
     * createdAt/updatedAt are also omitted because they're synthetic. */
    await this.auditService.record({
      entityType: AuditEntityType.USER,
      entityId: saved.id,
      action: 'user.create',
      summary: `Created user ${saved.email}`,
      changes: {
        email: { before: null, after: saved.email },
        firstName: { before: null, after: saved.firstName },
        lastName: { before: null, after: saved.lastName },
        role: { before: null, after: saved.role ?? null },
        programId: { before: null, after: saved.programId ?? null },
        centerId: { before: null, after: saved.centerId ?? null },
        isActive: { before: null, after: saved.isActive },
      },
    });

    return hydrated as User;
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
    const user = await this.findById(id);

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
   * Update admin-managed fields on a user record (role, program, center,
   * active status).
   *
   * @param id      - The user ID to update.
   * @param updates - Partial object with fields to change.
   * @returns The updated user entity.
   * @throws NotFoundException if no user exists with the given ID.
   */
  async updateUser(id: number, updates: AdminUpdatePayload): Promise<User> {
    const user = await this.findById(id);

    if (!user) {
      throw new NotFoundException(`User with ID "${id}" not found`);
    }

    /* Snapshot the prior values BEFORE Object.assign so the audit diff
     * sees the true before/after pair. We only audit the fields the
     * payload may carry — relations are loaded by the controller after
     * the save. */
    const before = {
      role: user.role ?? null,
      isActive: user.isActive,
      centerId: user.centerId ?? null,
      programId: user.programId ?? null,
    };

    Object.assign(user, updates);
    const saved = await this.usersRepository.save(user);
    this.logger.log(`Admin updated user ${id}: ${JSON.stringify(updates)}`);

    const after = {
      role: saved.role ?? null,
      isActive: saved.isActive,
      centerId: saved.centerId ?? null,
      programId: saved.programId ?? null,
    };

    /* Build the diff payload manually for the four audit-relevant fields
     * — using AuditService.computeChanges() would also work but the local
     * shape is small and we want explicit nullable handling. */
    type AuditDiff = Record<string, { before: unknown; after: unknown }>;
    const changes: AuditDiff = {};
    for (const key of ['role', 'isActive', 'centerId', 'programId'] as const) {
      if (before[key] !== after[key]) {
        changes[key] = { before: before[key], after: after[key] };
      }
    }

    if (Object.keys(changes).length === 0) {
      /* No effective change — skip the audit row. The save() above is
       * idempotent so this is safe. */
      return saved;
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
    } else if ('centerId' in changes || 'programId' in changes) {
      action = 'user.reassigned';
    }

    await this.auditService.record({
      entityType: AuditEntityType.USER,
      entityId: id,
      action,
      changes,
      summary: `Updated user ${saved.email}`,
    });

    return saved;
  }
}
