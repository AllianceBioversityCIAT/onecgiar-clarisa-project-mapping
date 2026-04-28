import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ProjectMapping } from './entities/project-mapping.entity';
import { MappingNegotiation } from './entities/mapping-negotiation.entity';
import { ProjectNegotiationMessage } from './entities/project-negotiation-message.entity';
import { NegotiationGateway } from './gateways/negotiation.gateway';
import { Project } from '../projects/entities/project.entity';
import { Program } from '../reference-data/entities/program.entity';
import { CreateMappingDto } from './dto/create-mapping.dto';
import { CounterProposeDto } from './dto/counter-propose.dto';
import { MappingQueryDto } from './dto/mapping-query.dto';
import { MappingStatus } from './enums/mapping-status.enum';
import { NegotiationEventType } from './enums/negotiation-event-type.enum';
import { ActorRole } from './enums/actor-role.enum';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

/**
 * Single event in a project's consolidated negotiation stream.
 *
 * Merges two logical event sources:
 *  - `mapping`  — rows from `mapping_negotiations` for any non-removed
 *                 mapping on the project (initiated, counter_proposed,
 *                 agreed, reopened, removed).
 *  - `message`  — free-text project-level chat from
 *                 `project_negotiation_messages`.
 */
export interface ConsolidatedEvent {
  id: number;
  kind: 'mapping' | 'message';
  /** Null for `message` kind (chat is project-scoped, not mapping-scoped). */
  mappingId: number | null;
  /** Display label for the related program; null for `message` kind. */
  programName: string | null;
  actorId: number;
  actorRole: UserRole;
  actorName: string;
  /** `NegotiationEventType` for `mapping` kind; literal `'message'` for chat. */
  eventType: NegotiationEventType | 'message';
  proposedPercentage: number | null;
  message: string | null;
  createdAt: Date;
}

/**
 * Consolidated view payload returned by `GET /mappings/projects/:projectId/consolidated`.
 *
 * Mappings carry their negotiation state (allocation, status, agreement
 * flags) but NOT per-mapping threads anymore — the full history lives
 * in the project-level `events` stream.
 */
export interface ConsolidatedView {
  project: {
    id: number;
    code: string;
    name: string;
    center: { id: number; name: string };
  };
  isLocked: boolean;
  canLock: boolean;
  totalAllocated: number;
  unallocated: number;
  mappings: Array<{
    id: number;
    programId: number;
    programName: string;
    allocationPercentage: number;
    status: MappingStatus;
    centerAgreed: boolean;
    programAgreed: boolean;
    needsAssistance: boolean;
    flaggedAt: Date | null;
  }>;
  events: ConsolidatedEvent[];
}

/**
 * Allocation summary for a project, showing how much has been
 * claimed by various programs and what remains.
 */
export interface AllocationSummary {
  totalAllocated: number;
  remaining: number;
  isComplete: boolean;
  isLocked: boolean;
  canLock: boolean;
  mappings: Array<{
    id: number;
    programId: number;
    programName: string;
    allocation: number;
    status: MappingStatus;
    centerAgreed: boolean;
    programAgreed: boolean;
  }>;
}

/**
 * Service handling the mapping negotiation workflow.
 *
 * Center representatives initiate mappings, then negotiate allocation
 * percentages with program representatives. Both sides must agree
 * before the center can lock the project round.
 */
@Injectable()
export class MappingsService {
  private readonly logger = new Logger(MappingsService.name);

  constructor(
    @InjectRepository(ProjectMapping)
    private readonly mappingRepository: Repository<ProjectMapping>,
    @InjectRepository(MappingNegotiation)
    private readonly negotiationRepository: Repository<MappingNegotiation>,
    @InjectRepository(ProjectNegotiationMessage)
    private readonly chatMessageRepository: Repository<ProjectNegotiationMessage>,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Program)
    private readonly programRepository: Repository<Program>,
    private readonly dataSource: DataSource,
    private readonly negotiationGateway: NegotiationGateway,
  ) {}

  // ─── Creation ─────────────────────────────────────────────────────

  /**
   * Creates a new mapping in draft status.
   *
   * Only center representatives can create mappings for projects
   * belonging to their center. If a removed mapping exists for the
   * same project+program, it is reused (reset to draft).
   */
  async create(dto: CreateMappingDto, user: User): Promise<ProjectMapping> {
    // Admin and workflow_admin can create on any project's behalf;
    // center reps must own the project's center.
    const isAdminLike =
      user.role === UserRole.ADMIN || user.role === UserRole.WORKFLOW_ADMIN;
    const isOwningCenterRep =
      user.role === UserRole.CENTER_REP && !!user.centerId;
    if (!isAdminLike && !isOwningCenterRep) {
      throw new ForbiddenException(
        'Only center representatives, admins, or workflow admins can create mappings',
      );
    }

    const project = await this.projectRepository.findOneBy({
      id: dto.projectId,
    });
    if (!project) {
      throw new NotFoundException(
        `Project with ID "${dto.projectId}" not found`,
      );
    }
    if (project.status !== ProjectStatus.ACTIVE) {
      throw new BadRequestException(
        'Mappings can only be created for active projects',
      );
    }
    if (!isAdminLike && project.centerId !== user.centerId) {
      throw new ForbiddenException(
        'You can only create mappings for projects in your center',
      );
    }

    const program = await this.programRepository.findOneBy({
      id: dto.programId,
    });
    if (!program) {
      throw new NotFoundException(
        `Program with ID "${dto.programId}" not found`,
      );
    }

    // Check for existing mapping (unique constraint)
    const existing = await this.mappingRepository.findOneBy({
      projectId: dto.projectId,
      programId: dto.programId,
    });

    if (existing && existing.status !== MappingStatus.REMOVED) {
      throw new ConflictException(
        'Mapping already exists for this project and program',
      );
    }

    const now = new Date();

    const result = await this.dataSource.transaction(async (manager) => {
      let saved: ProjectMapping;

      if (existing) {
        // Reuse removed mapping row. Initiator (center rep) implicitly agrees.
        existing.allocationPercentage = dto.allocationPercentage;
        existing.status = MappingStatus.NEGOTIATING;
        existing.centerAgreed = true;
        existing.programAgreed = false;
        existing.initiatedById = user.id;
        existing.initiatedAt = now;
        existing.rejectionReason = null;
        saved = await manager.save(ProjectMapping, existing);
        this.logger.log(
          `Mapping reused (was removed): project=${dto.projectId}, program=${dto.programId}`,
        );
      } else {
        const mapping = new ProjectMapping();
        mapping.projectId = dto.projectId;
        mapping.programId = dto.programId;
        mapping.allocationPercentage = dto.allocationPercentage;
        mapping.status = MappingStatus.NEGOTIATING;
        // Center rep initiating implicitly agrees to their own opening offer.
        mapping.centerAgreed = true;
        mapping.programAgreed = false;
        mapping.initiatedById = user.id;
        mapping.initiatedAt = now;
        // Legacy columns
        mapping.submittedById = user.id;
        mapping.submittedAt = now;
        saved = await manager.save(ProjectMapping, mapping);
        this.logger.log(
          `Mapping created: project=${dto.projectId}, program=${dto.programId}, allocation=${dto.allocationPercentage}%`,
        );
      }

      // Record initiated event with the actor's real role.
      const event = new MappingNegotiation();
      event.mappingId = saved.id;
      event.actorId = user.id;
      event.actorRole = this.toActorRole(user);
      event.eventType = NegotiationEventType.INITIATED;
      event.proposedAllocation = dto.allocationPercentage;
      await manager.save(MappingNegotiation, event);

      return manager.findOne(ProjectMapping, {
        where: { id: saved.id },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(dto.projectId, 'mapping.created');
    return result;
  }

  // ─── Negotiation Actions ──────────────────────────────────────────

  /**
   * Opens negotiation on a draft mapping (draft → negotiating).
   * Only the center rep who owns the project can do this.
   */
  async openNegotiation(
    mappingId: number,
    user: User,
  ): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);
    this.validateCenterRepOwnership(mapping, user);

    if (mapping.status !== MappingStatus.DRAFT) {
      throw new BadRequestException(
        'Only draft mappings can be opened for negotiation',
      );
    }

    mapping.status = MappingStatus.NEGOTIATING;
    await this.mappingRepository.save(mapping);
    this.logger.log(`Mapping ${mappingId} opened for negotiation`);

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.opened',
    );
    return this.findOneInternal(mappingId);
  }

  /**
   * Submits a counter-proposal on a mapping.
   *
   * Either center rep (owning center) or program rep (owning program)
   * can counter-propose. Resets both agreement flags. The 100% rule
   * is NOT enforced here — only at lock time.
   */
  async counterPropose(
    mappingId: number,
    dto: CounterProposeDto,
    user: User,
  ): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);

    if (mapping.status !== MappingStatus.NEGOTIATING) {
      throw new BadRequestException(
        'Counter-proposals can only be made on negotiating mappings',
      );
    }

    const { actorRole, side } = this.validateNegotiationAccess(mapping, user);

    const result = await this.dataSource.transaction(async (manager) => {
      // Update allocation and reset agreement flags. The proposer
      // implicitly agrees to their own offer — only the counter-party
      // still needs to confirm.
      mapping.allocationPercentage = dto.proposedAllocation;
      mapping.centerAgreed = side === 'center';
      mapping.programAgreed = side === 'program';
      await manager.save(ProjectMapping, mapping);

      // Record the event with the actor's real role (admin/workflow_admin
      // are no longer collapsed into center_rep).
      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = actorRole;
      event.eventType = NegotiationEventType.COUNTER_PROPOSED;
      event.proposedAllocation = dto.proposedAllocation;
      event.justification = dto.justification;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Mapping ${mappingId} counter-proposed by ${actorRole} (user ${user.id}): ${dto.proposedAllocation}%`,
      );

      // Auto-flag for workflow-admin assistance once the program rep
      // has counter-proposed at least twice on this mapping. We count
      // ALL program-rep counter-proposals on the mapping (including the
      // one just inserted above) — the >= 2 threshold is the documented
      // signal that the parties are deadlocked.
      // Note: TypeORM returns MySQL tinyint(1) as 0/1 integers, so we use
      // a truthy check instead of `=== false` (which would never match).
      if (actorRole === ActorRole.PROGRAM_REP && !mapping.needsAssistance) {
        const programRepCounters = await manager.count(MappingNegotiation, {
          where: {
            mappingId,
            eventType: NegotiationEventType.COUNTER_PROPOSED,
            actorRole: ActorRole.PROGRAM_REP,
          },
        });

        if (programRepCounters >= 2) {
          mapping.needsAssistance = true;
          mapping.flaggedAt = new Date();
          await manager.save(ProjectMapping, mapping);

          // Second audit row so the consolidated stream surfaces the
          // flag transition explicitly. Actor is the program rep who
          // tripped the threshold; their real role is recorded.
          const flagEvent = new MappingNegotiation();
          flagEvent.mappingId = mappingId;
          flagEvent.actorId = user.id;
          flagEvent.actorRole = actorRole;
          flagEvent.eventType = NegotiationEventType.FLAGGED_FOR_ASSISTANCE;
          await manager.save(MappingNegotiation, flagEvent);

          this.logger.log(
            `Mapping ${mappingId} flagged for assistance after ${programRepCounters} program-rep counter-proposals`,
          );
        }
      }

      return manager.findOne(ProjectMapping, {
        where: { id: mappingId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.counter_proposed',
    );
    return result;
  }

  /**
   * Marks the current user's agreement on the mapping's current terms.
   *
   * If both sides have agreed, transitions status to `agreed`.
   * Idempotent: calling again from the same side is a no-op.
   */
  async agree(mappingId: number, user: User): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);

    if (mapping.status !== MappingStatus.NEGOTIATING) {
      throw new BadRequestException('Can only agree on negotiating mappings');
    }

    const { actorRole, side } = this.validateNegotiationAccess(mapping, user);

    const result = await this.dataSource.transaction(async (manager) => {
      // Set the appropriate flag based on which side the actor represents.
      if (side === 'center') {
        mapping.centerAgreed = true;
      } else {
        mapping.programAgreed = true;
      }

      // If both agreed, transition to agreed status and auto-clear any
      // outstanding "needs assistance" flag — the parties resolved
      // themselves, no arbitration needed. No audit event for the clear:
      // the AGREED event already tells that story.
      if (mapping.centerAgreed && mapping.programAgreed) {
        mapping.status = MappingStatus.AGREED;
        if (mapping.needsAssistance) {
          mapping.needsAssistance = false;
          mapping.flaggedAt = null;
        }
        this.logger.log(
          `Mapping ${mappingId} fully agreed — both sides confirmed`,
        );
      }

      await manager.save(ProjectMapping, mapping);

      // Record the event with the actor's real role.
      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = actorRole;
      event.eventType = NegotiationEventType.AGREED;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Mapping ${mappingId}: ${actorRole} agreed (center=${mapping.centerAgreed}, program=${mapping.programAgreed})`,
      );

      return manager.findOne(ProjectMapping, {
        where: { id: mappingId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.agreed',
    );
    return result;
  }

  /**
   * Removes a program from the negotiation (center rep or program rep).
   *
   * Both sides can remove the mapping:
   *  - Center rep: removes the program from the project round.
   *  - Program rep: withdraws their program from the negotiation.
   *
   * A written justification is required and is recorded in the
   * negotiation thread as a `removed` event.
   */
  async removeProgram(
    mappingId: number,
    justification: string,
    user: User,
  ): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);

    if (
      mapping.status !== MappingStatus.DRAFT &&
      mapping.status !== MappingStatus.NEGOTIATING
    ) {
      throw new BadRequestException(
        'Only draft or negotiating mappings can be removed',
      );
    }

    // Either the owning center rep, owning program rep, admin, or
    // workflow_admin can remove.
    const { actorRole } = this.validateNegotiationAccess(mapping, user);

    const result = await this.dataSource.transaction(async (manager) => {
      mapping.status = MappingStatus.REMOVED;
      mapping.centerAgreed = false;
      mapping.programAgreed = false;
      await manager.save(ProjectMapping, mapping);

      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = actorRole;
      event.eventType = NegotiationEventType.REMOVED;
      event.justification = justification;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Mapping ${mappingId} removed by ${actorRole} (user ${user.id})`,
      );

      return manager.findOne(ProjectMapping, {
        where: { id: mappingId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'mapping.removed',
    );
    return result;
  }

  // ─── Project-Level Actions ────────────────────────────────────────

  /**
   * Locks project-level negotiation by flipping `projects.negotiation_locked`
   * to true. Gate: every non-removed mapping must be `agreed` AND the sum
   * of allocation percentages must NOT exceed 100. Locking with under-100%
   * allocation is allowed — the unallocated portion is intentional.
   *
   * Uses pessimistic_write on the project row so two concurrent lock
   * attempts cannot both pass the gate. Mapping rows are NOT mutated
   * here — the project flag is the source of truth for lock state.
   */
  async lockProjectRound(projectId: number, user: User): Promise<Project> {
    const result = await this.dataSource.transaction(async (manager) => {
      // Pessimistic-lock the project row before reading mappings,
      // so a concurrent lock/mapping-update can't invalidate our gate.
      const project = await manager
        .createQueryBuilder(Project, 'project')
        .setLock('pessimistic_write')
        .where('project.id = :projectId', { projectId })
        .getOne();

      if (!project) {
        throw new NotFoundException(`Project with ID "${projectId}" not found`);
      }

      this.assertCanToggleLock(project, user);

      const mappings = await manager.find(ProjectMapping, {
        where: { projectId },
      });
      const active = mappings.filter((m) => m.status !== MappingStatus.REMOVED);

      if (active.length === 0) {
        throw new BadRequestException(
          'Cannot lock: no active mappings exist for this project',
        );
      }

      const total = active.reduce(
        (sum, m) => sum + Number(m.allocationPercentage),
        0,
      );
      if (total - 100 > 0.01) {
        throw new BadRequestException(
          `Cannot lock: allocations total ${total}%, cannot exceed 100%`,
        );
      }

      const notAgreed = active.filter((m) => m.status !== MappingStatus.AGREED);
      if (notAgreed.length > 0) {
        throw new BadRequestException(
          `Cannot lock: ${notAgreed.length} mapping(s) are not in 'agreed' status`,
        );
      }

      project.negotiationLocked = true;
      await manager.save(Project, project);

      this.logger.log(
        `Project ${projectId} negotiation locked by user ${user.id}`,
      );

      return project;
    });

    this.negotiationGateway.emitProjectUpdate(projectId, 'project.locked');
    return result;
  }

  /**
   * Reopens project-level negotiation by flipping `projects.negotiation_locked`
   * to false. No gate — admin/center_rep can always reopen. Mapping rows
   * are not touched; their existing status is preserved.
   */
  async reopenProjectRound(projectId: number, user: User): Promise<Project> {
    const result = await this.dataSource.transaction(async (manager) => {
      const project = await manager.findOneBy(Project, { id: projectId });
      if (!project) {
        throw new NotFoundException(`Project with ID "${projectId}" not found`);
      }

      this.assertCanToggleLock(project, user);

      project.negotiationLocked = false;
      await manager.save(Project, project);

      // Revert all agreed mappings back to negotiating so the conversation
      // can continue. Both agreement flags are cleared so each side must
      // re-confirm before the project can be locked again.
      await manager
        .createQueryBuilder()
        .update(ProjectMapping)
        .set({
          status: MappingStatus.NEGOTIATING,
          centerAgreed: false,
          programAgreed: false,
        })
        .where('project_id = :projectId', { projectId })
        .andWhere('status = :agreed', { agreed: MappingStatus.AGREED })
        .execute();

      // Record a reopened event against every non-removed mapping so the
      // feed shows the transition per program. The `needs_assistance`
      // flag is intentionally NOT cleared here — a reopened round may
      // still need workflow-admin attention until both sides re-agree.
      // The current allocation is captured as the snapshot on the event
      // so the new "open offer" is anchored to this fresh row — replies
      // (Agree / Counter-Propose) target the reopen event, not the
      // historical proposals from the prior round.
      const active = await manager.find(ProjectMapping, {
        where: { projectId },
      });
      const role = this.toActorRole(user);
      for (const m of active) {
        if (m.status === MappingStatus.REMOVED) continue;
        const event = new MappingNegotiation();
        event.mappingId = m.id;
        event.actorId = user.id;
        event.actorRole = role;
        event.eventType = NegotiationEventType.REOPENED;
        event.proposedAllocation = m.allocationPercentage;
        await manager.save(MappingNegotiation, event);
      }

      this.logger.log(
        `Project ${projectId} negotiation reopened by user ${user.id}`,
      );

      return project;
    });

    this.negotiationGateway.emitProjectUpdate(projectId, 'project.reopened');
    return result;
  }

  /**
   * RBAC gate shared by lock/reopen: admin, workflow_admin, OR
   * center_rep whose centerId matches the project's centerId.
   */
  private assertCanToggleLock(project: Project, user: User): void {
    if (user.role === UserRole.ADMIN || user.role === UserRole.WORKFLOW_ADMIN) {
      return;
    }
    if (
      user.role === UserRole.CENTER_REP &&
      user.centerId === project.centerId
    ) {
      return;
    }
    throw new ForbiddenException(
      'Only admins, workflow admins, or the project center representative can toggle lock state',
    );
  }

  // ─── Queries ──────────────────────────────────────────────────────

  /**
   * Retrieves a paginated list of mappings with role-based filtering.
   *
   * - Admin: sees all mappings.
   * - Program rep: sees only negotiating/agreed/locked for their program (not draft/removed).
   * - Center rep: sees mappings for projects belonging to their center.
   */
  async findAll(
    query: MappingQueryDto,
    user: User,
  ): Promise<{
    data: ProjectMapping[];
    total: number;
    page: number;
    limit: number;
  }> {
    const qb = this.mappingRepository
      .createQueryBuilder('mapping')
      .leftJoinAndSelect('mapping.project', 'project')
      .leftJoinAndSelect('project.center', 'center')
      .leftJoinAndSelect('mapping.program', 'program')
      .leftJoinAndSelect('mapping.initiatedBy', 'initiator');

    /* Role-based access scoping. Admin and workflow_admin see every
     * mapping; the others are scoped to their program / center. */
    if (user.role === UserRole.PROGRAM_REP) {
      qb.andWhere('mapping.programId = :userProgramId', {
        userProgramId: user.programId,
      });
      // Program reps don't see drafts or removed
      qb.andWhere('mapping.status NOT IN (:...hiddenStatuses)', {
        hiddenStatuses: [MappingStatus.DRAFT, MappingStatus.REMOVED],
      });
    } else if (user.role === UserRole.CENTER_REP) {
      qb.andWhere('project.centerId = :userCenterId', {
        userCenterId: user.centerId,
      });
    }
    /* Admin and workflow_admin see everything (no scoping). */

    /* Optional filters */
    if (query.status) {
      qb.andWhere('mapping.status = :status', { status: query.status });
    }
    if (query.programId) {
      qb.andWhere('mapping.programId = :programId', {
        programId: query.programId,
      });
    }
    if (query.projectId) {
      qb.andWhere('mapping.projectId = :projectId', {
        projectId: query.projectId,
      });
    }
    if (query.search) {
      qb.andWhere('project.name LIKE :search', {
        search: `%${query.search}%`,
      });
    }

    /* Pagination */
    const offset = (query.page - 1) * query.limit;
    qb.orderBy('mapping.created_at', 'DESC').offset(offset).limit(query.limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Retrieves a single mapping by ID with access control.
   */
  async findOne(id: number, user: User): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(id);
    this.checkReadAccess(mapping, user);
    return mapping;
  }

  /**
   * Returns the negotiation thread (conversation history) for a mapping.
   */
  async getNegotiationThread(
    mappingId: number,
    user: User,
  ): Promise<{ mapping: ProjectMapping; negotiations: MappingNegotiation[] }> {
    const mapping = await this.findOneInternal(mappingId);
    this.checkReadAccess(mapping, user);

    const negotiations = await this.negotiationRepository.find({
      where: { mappingId },
      relations: ['actor'],
      order: { createdAt: 'ASC' },
    });

    return { mapping, negotiations };
  }

  /**
   * Returns the allocation summary for a project.
   */
  async getAllocationSummary(projectId: number): Promise<AllocationSummary> {
    const project = await this.projectRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    const mappings = await this.mappingRepository.find({
      where: { projectId },
      relations: ['program'],
      order: { createdAt: 'ASC' },
    });

    // Non-removed mappings count toward the total
    const active = mappings.filter((m) => m.status !== MappingStatus.REMOVED);
    const totalAllocated = active.reduce(
      (sum, m) => sum + Number(m.allocationPercentage),
      0,
    );
    const allAgreed =
      active.length > 0 &&
      active.every((m) => m.status === MappingStatus.AGREED);
    const isLocked = project.negotiationLocked;
    // Lock-eligible: all active mappings agreed AND no over-allocation.
    // Under-allocation (e.g. 80% mapped, 20% unallocated) is allowed.
    const isComplete = allAgreed && totalAllocated - 100 <= 0.01;

    return {
      totalAllocated,
      remaining: 100 - totalAllocated,
      isComplete,
      isLocked,
      canLock: isComplete && !isLocked,
      mappings: mappings.map((m) => ({
        id: m.id,
        programId: m.programId,
        programName: m.program.name,
        allocation: Number(m.allocationPercentage),
        status: m.status,
        centerAgreed: m.centerAgreed,
        programAgreed: m.programAgreed,
      })),
    };
  }

  /**
   * Returns mappings for a project with role-scoped visibility.
   *
   * - Admin / workflow_admin: all mappings.
   * - Center rep (matching center): all mappings.
   * - Any other authenticated user (program_rep / center_rep of another
   *   center): all non-draft, non-removed mappings (read-only audit view).
   */
  async getReviewSummary(
    projectId: number,
    user: User,
  ): Promise<ProjectMapping[]> {
    const project = await this.projectRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    const isOwningCenterRep =
      user.role === UserRole.CENTER_REP && user.centerId === project.centerId;
    const canSeeAll =
      user.role === UserRole.ADMIN ||
      user.role === UserRole.WORKFLOW_ADMIN ||
      isOwningCenterRep;

    const qb = this.mappingRepository
      .createQueryBuilder('mapping')
      .leftJoinAndSelect('mapping.project', 'project')
      .leftJoinAndSelect('project.center', 'center')
      .leftJoinAndSelect('mapping.program', 'program')
      .leftJoinAndSelect('mapping.initiatedBy', 'initiator')
      .where('mapping.projectId = :projectId', { projectId })
      .orderBy('mapping.created_at', 'ASC');

    if (!canSeeAll) {
      // Non-owners see only non-draft, non-removed mappings
      qb.andWhere('mapping.status NOT IN (:...hidden)', {
        hidden: [MappingStatus.DRAFT, MappingStatus.REMOVED],
      });
    }

    return qb.getMany();
  }

  /**
   * Returns the consolidated negotiation view for a project: header,
   * lock state, totals, every non-removed mapping, AND a single
   * chronological `events` stream that merges mapping negotiation
   * audit rows with project-level chat messages.
   *
   * Single trip to the DB per source (project, mappings, negotiations,
   * chat). Actors are eager-joined to avoid N+1 when building actor
   * display names.
   */
  async getConsolidatedView(projectId: number): Promise<ConsolidatedView> {
    // Project + center header
    const project = await this.projectRepository
      .createQueryBuilder('project')
      .leftJoinAndSelect('project.center', 'center')
      .where('project.id = :projectId', { projectId })
      .getOne();

    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    // Active (non-removed) mappings with program, ordered by creation
    const mappings = await this.mappingRepository
      .createQueryBuilder('mapping')
      .leftJoinAndSelect('mapping.program', 'program')
      .where('mapping.projectId = :projectId', { projectId })
      .andWhere('mapping.status != :removed', {
        removed: MappingStatus.REMOVED,
      })
      .orderBy('mapping.created_at', 'ASC')
      .getMany();

    // Fast lookup: mappingId -> programName, for labeling mapping events
    const programNameByMapping = new Map<number, string>();
    for (const m of mappings) {
      programNameByMapping.set(m.id, m.program?.name ?? '');
    }

    // Negotiation events for the project's non-removed mappings
    const mappingIds = mappings.map((m) => m.id);
    const negotiationRows = mappingIds.length
      ? await this.negotiationRepository
          .createQueryBuilder('event')
          .leftJoinAndSelect('event.actor', 'actor')
          .where('event.mappingId IN (:...ids)', { ids: mappingIds })
          .orderBy('event.created_at', 'ASC')
          .getMany()
      : [];

    // Project-level chat messages
    const chatRows = await this.chatMessageRepository
      .createQueryBuilder('msg')
      .leftJoinAndSelect('msg.actor', 'actor')
      .where('msg.projectId = :projectId', { projectId })
      .orderBy('msg.created_at', 'ASC')
      .getMany();

    // Merge both sources into one chronological stream
    const events: ConsolidatedEvent[] = [
      ...negotiationRows.map((ev) =>
        this.toMappingEvent(ev, programNameByMapping.get(ev.mappingId) ?? null),
      ),
      ...chatRows.map((msg) => this.toChatEvent(msg)),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const totalAllocated = mappings.reduce(
      (sum, m) => sum + Number(m.allocationPercentage),
      0,
    );
    // Lock-eligible: at least one active mapping, all of them agreed,
    // and no over-allocation. Under-100 is intentional and allowed.
    const canLock =
      mappings.length > 0 &&
      mappings.every((m) => m.status === MappingStatus.AGREED) &&
      totalAllocated - 100 <= 0.01 &&
      !project.negotiationLocked;

    return {
      project: {
        id: project.id,
        code: project.code,
        name: project.name,
        center: {
          id: project.center?.id ?? project.centerId,
          name: project.center?.name ?? '',
        },
      },
      isLocked: project.negotiationLocked,
      canLock,
      totalAllocated,
      unallocated: 100 - totalAllocated,
      mappings: mappings.map((m) => ({
        id: m.id,
        programId: m.programId,
        programName: m.program?.name ?? '',
        allocationPercentage: Number(m.allocationPercentage),
        status: m.status,
        centerAgreed: m.centerAgreed,
        programAgreed: m.programAgreed,
        needsAssistance: Boolean(m.needsAssistance),
        flaggedAt: m.flaggedAt,
      })),
      events,
    };
  }

  /**
   * Posts a free-text chat message on a project's consolidated
   * negotiation thread.
   *
   * RBAC: admin, the owning center rep of the project, or a program
   * rep whose `user.programId` matches a non-removed mapping on the
   * project. Rejected if the project's negotiation is locked.
   */
  async postChatMessage(
    projectId: number,
    message: string,
    user: User,
  ): Promise<ConsolidatedEvent> {
    // Load the project to check the lock flag and ownership
    const project = await this.projectRepository.findOne({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }
    if (project.negotiationLocked) {
      throw new ForbiddenException(
        'Project negotiation is locked; chat is read-only',
      );
    }

    // Authorization check — admin / center rep of project / program rep
    // with a non-removed mapping on this project
    await this.assertCanChat(project, user);

    // Persist the message
    const entity = this.chatMessageRepository.create({
      projectId,
      actorId: user.id,
      message,
    });
    const saved = await this.chatMessageRepository.save(entity);

    // Re-read with actor relation so we can build a consistent event
    // payload (actor name/role) without trusting the in-memory `user`
    // in case of stale fields.
    const withActor = await this.chatMessageRepository
      .createQueryBuilder('msg')
      .leftJoinAndSelect('msg.actor', 'actor')
      .where('msg.id = :id', { id: saved.id })
      .getOne();

    this.logger.log(
      `Chat message posted: project=${projectId} actor=${user.id} messageId=${saved.id}`,
    );

    this.negotiationGateway.emitProjectUpdate(projectId, 'chat.posted');
    return this.toChatEvent(withActor ?? saved);
  }

  /**
   * Verifies the caller is allowed to post a chat message on this
   * project. Throws `ForbiddenException` otherwise.
   */
  private async assertCanChat(project: Project, user: User): Promise<void> {
    if (user.role === UserRole.ADMIN || user.role === UserRole.WORKFLOW_ADMIN) {
      return;
    }
    if (
      user.role === UserRole.CENTER_REP &&
      user.centerId &&
      user.centerId === project.centerId
    ) {
      return;
    }
    if (user.role === UserRole.PROGRAM_REP && user.programId) {
      // Program rep must own at least one non-removed mapping on this
      // project. A single count query keeps this cheap.
      const count = await this.mappingRepository
        .createQueryBuilder('mapping')
        .where('mapping.projectId = :projectId', { projectId: project.id })
        .andWhere('mapping.programId = :programId', {
          programId: user.programId,
        })
        .andWhere('mapping.status != :removed', {
          removed: MappingStatus.REMOVED,
        })
        .getCount();
      if (count > 0) {
        return;
      }
    }
    throw new ForbiddenException(
      'You do not have permission to post on this project',
    );
  }

  /** Formats a mapping negotiation row as a ConsolidatedEvent. */
  private toMappingEvent(
    ev: MappingNegotiation,
    programName: string | null,
  ): ConsolidatedEvent {
    return {
      id: ev.id,
      kind: 'mapping',
      mappingId: ev.mappingId,
      programName,
      actorId: ev.actorId,
      // ActorRole values map 1:1 onto UserRole values for the four roles
      // we model — the cast is safe because both enums share the same
      // string literals (`admin`, `workflow_admin`, `center_rep`,
      // `program_rep`). Older rows stored prior to A3 will still be
      // `center_rep` for events triggered by an admin.
      actorRole: ev.actorRole as unknown as UserRole,
      actorName: ev.actor
        ? `${ev.actor.firstName ?? ''} ${ev.actor.lastName ?? ''}`.trim() ||
          ev.actor.email
        : '',
      eventType: ev.eventType,
      proposedPercentage:
        ev.proposedAllocation === null ? null : Number(ev.proposedAllocation),
      message: ev.justification,
      createdAt: ev.createdAt,
    };
  }

  /** Formats a project chat message row as a ConsolidatedEvent. */
  private toChatEvent(msg: ProjectNegotiationMessage): ConsolidatedEvent {
    return {
      id: msg.id,
      kind: 'message',
      mappingId: null,
      programName: null,
      actorId: msg.actorId,
      actorRole: (msg.actor?.role as UserRole) ?? UserRole.ADMIN,
      actorName: msg.actor
        ? `${msg.actor.firstName ?? ''} ${msg.actor.lastName ?? ''}`.trim() ||
          msg.actor.email
        : '',
      eventType: 'message',
      proposedPercentage: null,
      message: msg.message,
      createdAt: msg.createdAt,
    };
  }

  /**
   * Inline update of a mapping's allocation percentage from the
   * consolidated allocation pane. Treated as a counter-proposal in
   * audit terms but with the proposer's side implicitly agreed —
   * mirrors `counterPropose()` so a center rep tweaking the % from
   * the right pane doesn't have to also click Agree afterwards to
   * close the loop. The other side still has to agree.
   *
   * No-op edits (same percentage as before) short-circuit and do not
   * reset agreement flags or write an audit event — guards against the
   * "I saved 50% over 50% and it cleared everyone's agreement" footgun.
   *
   * Rejected when the project is locked.
   */
  async updateAllocation(
    mappingId: number,
    newPercentage: number,
    user: User,
  ): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(mappingId);

    if (mapping.project.negotiationLocked) {
      throw new ForbiddenException(
        'Project negotiation is locked; allocations cannot be modified',
      );
    }

    // RBAC: admin, workflow_admin, owning center_rep, or owning program_rep.
    const actorRole = this.resolveAllocationActorRole(mapping, user);

    // No-op guard: if the value isn't changing, return the mapping as-is
    // without resetting flags or recording an event. Compare as numbers
    // since `allocation_percentage` is a DECIMAL string from the DB.
    if (Number(mapping.allocationPercentage) === Number(newPercentage)) {
      return mapping;
    }

    // Editor's "side" — admin / workflow_admin / center_rep all act on
    // behalf of the center; program_rep acts on the program side.
    const side: 'center' | 'program' =
      actorRole === ActorRole.PROGRAM_REP ? 'program' : 'center';

    const result = await this.dataSource.transaction(async (manager) => {
      mapping.allocationPercentage = newPercentage;
      // Implicit-agree on the editor's side, reset the other — the
      // editor proposed this number, so they're agreeing to it; the
      // other party hasn't seen it yet and must reconfirm.
      mapping.centerAgreed = side === 'center';
      mapping.programAgreed = side === 'program';
      // If already agreed, drop back to negotiating — terms changed.
      if (mapping.status === MappingStatus.AGREED) {
        mapping.status = MappingStatus.NEGOTIATING;
      }
      await manager.save(ProjectMapping, mapping);

      const event = new MappingNegotiation();
      event.mappingId = mappingId;
      event.actorId = user.id;
      event.actorRole = actorRole;
      event.eventType = NegotiationEventType.COUNTER_PROPOSED;
      event.proposedAllocation = newPercentage;
      event.justification = null;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Mapping ${mappingId} allocation updated to ${newPercentage}% by user ${user.id} (${actorRole}); ${side} side implicitly agreed`,
      );

      return manager.findOne(ProjectMapping, {
        where: { id: mappingId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(
      mapping.projectId,
      'allocation.updated',
    );
    return result;
  }

  /**
   * URL-scoped alias for creating a mapping on a specific project.
   * Enforces the project-lock gate and RBAC (admin or owning center_rep),
   * then delegates to `create()`. Conflicts surface as 409.
   */
  async addProgramToProject(
    projectId: number,
    programId: number,
    allocationPercentage: number,
    user: User,
  ): Promise<ProjectMapping> {
    const project = await this.projectRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    if (project.negotiationLocked) {
      throw new ForbiddenException(
        'Project negotiation is locked; programs cannot be added',
      );
    }

    // RBAC: admin, workflow_admin, or owning center rep.
    const isAdminLike =
      user.role === UserRole.ADMIN || user.role === UserRole.WORKFLOW_ADMIN;
    const isOwningCenterRep =
      user.role === UserRole.CENTER_REP && user.centerId === project.centerId;
    if (!isAdminLike && !isOwningCenterRep) {
      throw new ForbiddenException(
        'Only admins, workflow admins, or the project center representative can add programs',
      );
    }

    // 409 if a non-removed mapping already exists
    const existing = await this.mappingRepository.findOneBy({
      projectId,
      programId,
    });
    if (existing && existing.status !== MappingStatus.REMOVED) {
      throw new ConflictException(
        'Mapping already exists for this project and program',
      );
    }

    // Admin and workflow_admin route through the elevated path so we
    // skip the center_rep ownership gate inside create() while keeping
    // the audit row attributed to the actor's real role.
    if (isAdminLike) {
      return this.createAsAdminOrCenter(
        projectId,
        programId,
        allocationPercentage,
        user,
        project.centerId,
      );
    }

    return this.create({ projectId, programId, allocationPercentage }, user);
  }

  /**
   * Internal variant of create() that skips the center_rep role gate so
   * admins can create mappings via the consolidated page. Mirrors the
   * transactional behavior of create(): reuses removed rows and records
   * an `initiated` event attributed to the caller.
   */
  private async createAsAdminOrCenter(
    projectId: number,
    programId: number,
    allocationPercentage: number,
    user: User,
    projectCenterId: number,
  ): Promise<ProjectMapping> {
    const program = await this.programRepository.findOneBy({ id: programId });
    if (!program) {
      throw new NotFoundException(`Program with ID "${programId}" not found`);
    }

    const existing = await this.mappingRepository.findOneBy({
      projectId,
      programId,
    });

    const now = new Date();

    const result = await this.dataSource.transaction(async (manager) => {
      let saved: ProjectMapping;

      if (existing) {
        existing.allocationPercentage = allocationPercentage;
        existing.status = MappingStatus.NEGOTIATING;
        existing.centerAgreed = true;
        existing.programAgreed = false;
        existing.initiatedById = user.id;
        existing.initiatedAt = now;
        existing.rejectionReason = null;
        saved = await manager.save(ProjectMapping, existing);
      } else {
        const mapping = new ProjectMapping();
        mapping.projectId = projectId;
        mapping.programId = programId;
        mapping.allocationPercentage = allocationPercentage;
        mapping.status = MappingStatus.NEGOTIATING;
        // Center rep (or admin) initiating implicitly agrees to their own offer.
        mapping.centerAgreed = true;
        mapping.programAgreed = false;
        mapping.initiatedById = user.id;
        mapping.initiatedAt = now;
        mapping.submittedById = user.id;
        mapping.submittedAt = now;
        saved = await manager.save(ProjectMapping, mapping);
      }

      const event = new MappingNegotiation();
      event.mappingId = saved.id;
      event.actorId = user.id;
      // Record the actor's real role — admin / workflow_admin are
      // first-class actor roles since A3 widened the enum.
      event.actorRole = this.toActorRole(user);
      event.eventType = NegotiationEventType.INITIATED;
      event.proposedAllocation = allocationPercentage;
      await manager.save(MappingNegotiation, event);

      this.logger.log(
        `Program ${programId} added to project ${projectId} by user ${user.id} (center ${projectCenterId})`,
      );

      return manager.findOne(ProjectMapping, {
        where: { id: saved.id },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });

    this.negotiationGateway.emitProjectUpdate(projectId, 'program.added');
    return result;
  }

  /**
   * RBAC resolver for `updateAllocation`. Validates that the user can
   * touch the allocation and returns the ActorRole to record on the
   * audit row. Admin and workflow_admin are recorded as themselves.
   */
  private resolveAllocationActorRole(
    mapping: ProjectMapping,
    user: User,
  ): ActorRole {
    if (user.role === UserRole.ADMIN) {
      return ActorRole.ADMIN;
    }
    if (user.role === UserRole.WORKFLOW_ADMIN) {
      return ActorRole.WORKFLOW_ADMIN;
    }
    if (
      user.role === UserRole.CENTER_REP &&
      user.centerId === mapping.project.centerId
    ) {
      return ActorRole.CENTER_REP;
    }
    if (
      user.role === UserRole.PROGRAM_REP &&
      user.programId === mapping.programId
    ) {
      return ActorRole.PROGRAM_REP;
    }
    throw new ForbiddenException(
      'You do not have access to update this allocation',
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────

  /** Loads a mapping by ID with all relations. Throws if not found. */
  private async findOneInternal(id: number): Promise<ProjectMapping> {
    const mapping = await this.mappingRepository.findOne({
      where: { id },
      relations: ['project', 'project.center', 'program', 'initiatedBy'],
    });

    if (!mapping) {
      throw new NotFoundException(`Mapping with ID "${id}" not found`);
    }

    return mapping;
  }

  /** Checks that the user has read access to the given mapping. */
  private checkReadAccess(mapping: ProjectMapping, user: User): void {
    // Admin and workflow_admin can read any mapping (workflow_admin
    // arbitrates across centers — they need the full picture).
    if (user.role === UserRole.ADMIN || user.role === UserRole.WORKFLOW_ADMIN) {
      return;
    }

    if (
      user.role === UserRole.PROGRAM_REP &&
      mapping.programId === user.programId
    ) {
      // Program reps can't see drafts
      if (mapping.status === MappingStatus.DRAFT) {
        throw new ForbiddenException('You do not have access to this mapping');
      }
      return;
    }

    if (
      user.role === UserRole.CENTER_REP &&
      mapping.project.centerId === user.centerId
    ) {
      return;
    }

    throw new ForbiddenException('You do not have access to this mapping');
  }

  /**
   * Validates that the user is a center rep who owns the project
   * this mapping belongs to.
   */
  private validateCenterRepOwnership(
    mapping: ProjectMapping,
    user: User,
  ): void {
    if (user.role !== UserRole.CENTER_REP) {
      throw new ForbiddenException(
        'Only center representatives can perform this action',
      );
    }
    if (user.centerId !== mapping.project.centerId) {
      throw new ForbiddenException(
        'You can only manage mappings for projects in your center',
      );
    }
  }

  /**
   * Validates that the user can participate in negotiation for this mapping.
   *
   * Returns:
   *  - `actorRole` — what to record on the negotiation event (admin and
   *    workflow_admin are recorded as themselves rather than collapsed
   *    into `center_rep`).
   *  - `side` — which side's agreement flag (`centerAgreed` /
   *    `programAgreed`) the actor's confirmation should set. Admin and
   *    workflow_admin are treated as the center side because they act
   *    on behalf of the project's owning center.
   */
  private validateNegotiationAccess(
    mapping: ProjectMapping,
    user: User,
  ): { actorRole: ActorRole; side: 'center' | 'program' } {
    if (user.role === UserRole.ADMIN) {
      return { actorRole: ActorRole.ADMIN, side: 'center' };
    }
    if (user.role === UserRole.WORKFLOW_ADMIN) {
      return { actorRole: ActorRole.WORKFLOW_ADMIN, side: 'center' };
    }
    if (
      user.role === UserRole.CENTER_REP &&
      user.centerId === mapping.project.centerId
    ) {
      return { actorRole: ActorRole.CENTER_REP, side: 'center' };
    }
    if (
      user.role === UserRole.PROGRAM_REP &&
      user.programId === mapping.programId
    ) {
      return { actorRole: ActorRole.PROGRAM_REP, side: 'program' };
    }

    throw new ForbiddenException(
      'You do not have access to negotiate this mapping',
    );
  }

  /**
   * Maps a User to the matching ActorRole for audit rows. Used by call
   * sites that have already verified RBAC and just need to stamp the
   * actor's real role onto the event.
   */
  private toActorRole(user: User): ActorRole {
    switch (user.role) {
      case UserRole.ADMIN:
        return ActorRole.ADMIN;
      case UserRole.WORKFLOW_ADMIN:
        return ActorRole.WORKFLOW_ADMIN;
      case UserRole.PROGRAM_REP:
        return ActorRole.PROGRAM_REP;
      case UserRole.CENTER_REP:
      default:
        return ActorRole.CENTER_REP;
    }
  }
}
