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
import { Project } from '../projects/entities/project.entity';
import { Program } from '../reference-data/entities/program.entity';
import { CreateMappingDto } from './dto/create-mapping.dto';
import { CounterProposeDto } from './dto/counter-propose.dto';
import { MappingQueryDto } from './dto/mapping-query.dto';
import { MappingStatus } from './enums/mapping-status.enum';
import { NegotiationEventType } from './enums/negotiation-event-type.enum';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { UserRole } from '../users/enums/user-role.enum';
import { User } from '../users/entities/user.entity';

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
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Program)
    private readonly programRepository: Repository<Program>,
    private readonly dataSource: DataSource,
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
    if (user.role !== UserRole.CENTER_REP || !user.centerId) {
      throw new ForbiddenException(
        'Only center representatives can create mappings',
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
    if (project.centerId !== user.centerId) {
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

    return this.dataSource.transaction(async (manager) => {
      let saved: ProjectMapping;

      if (existing) {
        // Reuse removed mapping row
        existing.allocationPercentage = dto.allocationPercentage;
        existing.status = MappingStatus.DRAFT;
        existing.centerAgreed = false;
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
        mapping.status = MappingStatus.DRAFT;
        mapping.centerAgreed = false;
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

      // Record initiated event
      const event = new MappingNegotiation();
      event.mappingId = saved.id;
      event.actorId = user.id;
      event.actorRole = 'center_rep';
      event.eventType = NegotiationEventType.INITIATED;
      event.proposedAllocation = dto.allocationPercentage;
      await manager.save(MappingNegotiation, event);

      return manager.findOne(ProjectMapping, {
        where: { id: saved.id },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });
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

    const actorRole = this.validateNegotiationAccess(mapping, user);

    return this.dataSource.transaction(async (manager) => {
      // Update allocation and reset agreement flags
      mapping.allocationPercentage = dto.proposedAllocation;
      mapping.centerAgreed = false;
      mapping.programAgreed = false;
      await manager.save(ProjectMapping, mapping);

      // Record the event
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

      return manager.findOne(ProjectMapping, {
        where: { id: mappingId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
      }) as Promise<ProjectMapping>;
    });
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

    const actorRole = this.validateNegotiationAccess(mapping, user);

    return this.dataSource.transaction(async (manager) => {
      // Set the appropriate flag
      if (actorRole === 'center_rep') {
        mapping.centerAgreed = true;
      } else {
        mapping.programAgreed = true;
      }

      // If both agreed, transition to agreed status
      if (mapping.centerAgreed && mapping.programAgreed) {
        mapping.status = MappingStatus.AGREED;
        this.logger.log(
          `Mapping ${mappingId} fully agreed — both sides confirmed`,
        );
      }

      await manager.save(ProjectMapping, mapping);

      // Record the event
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

    // Either the owning center rep or the owning program rep can remove
    const actorRole = this.validateNegotiationAccess(mapping, user);

    return this.dataSource.transaction(async (manager) => {
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
  }

  // ─── Project-Level Actions ────────────────────────────────────────

  /**
   * Locks all agreed mappings for a project (center rep only).
   *
   * Preconditions:
   * - All non-removed mappings must be in `agreed` status
   * - Non-removed allocations must sum to exactly 100%
   *
   * Uses pessimistic locking to prevent race conditions.
   */
  async lockProjectRound(
    projectId: number,
    user: User,
  ): Promise<ProjectMapping[]> {
    const project = await this.projectRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    if (
      user.role !== UserRole.CENTER_REP ||
      user.centerId !== project.centerId
    ) {
      throw new ForbiddenException(
        'Only the center representative for this project can lock the round',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // Lock all mappings for this project
      const mappings = await manager
        .createQueryBuilder(ProjectMapping, 'mapping')
        .setLock('pessimistic_write')
        .where('mapping.projectId = :projectId', { projectId })
        .andWhere('mapping.status != :removed', {
          removed: MappingStatus.REMOVED,
        })
        .getMany();

      if (mappings.length === 0) {
        throw new BadRequestException(
          'No non-removed mappings exist for this project',
        );
      }

      // All must be agreed
      const nonAgreed = mappings.filter(
        (m) => m.status !== MappingStatus.AGREED,
      );
      if (nonAgreed.length > 0) {
        throw new BadRequestException(
          `Cannot lock: ${nonAgreed.length} mapping(s) are not yet agreed`,
        );
      }

      // Must sum to 100%
      const total = mappings.reduce(
        (sum, m) => sum + Number(m.allocationPercentage),
        0,
      );
      if (Math.abs(total - 100) > 0.01) {
        throw new BadRequestException(
          `Cannot lock: allocations total ${total}%, must be exactly 100%`,
        );
      }

      // Transition all to locked
      for (const mapping of mappings) {
        mapping.status = MappingStatus.LOCKED;
        await manager.save(ProjectMapping, mapping);
      }

      this.logger.log(
        `Project ${projectId} round locked by center rep ${user.id} (${mappings.length} mappings)`,
      );

      return manager.find(ProjectMapping, {
        where: { projectId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
        order: { createdAt: 'ASC' },
      });
    });
  }

  /**
   * Reopens a locked project round for re-negotiation (center rep only).
   *
   * Transitions all locked mappings back to negotiating and resets
   * agreement flags. Inserts a `reopened` event for each mapping.
   */
  async reopenProjectRound(
    projectId: number,
    user: User,
  ): Promise<ProjectMapping[]> {
    const project = await this.projectRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    if (
      user.role !== UserRole.CENTER_REP ||
      user.centerId !== project.centerId
    ) {
      throw new ForbiddenException(
        'Only the center representative for this project can reopen the round',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const lockedMappings = await manager.find(ProjectMapping, {
        where: { projectId, status: MappingStatus.LOCKED },
      });

      if (lockedMappings.length === 0) {
        throw new BadRequestException(
          'No locked mappings exist for this project',
        );
      }

      for (const mapping of lockedMappings) {
        mapping.status = MappingStatus.NEGOTIATING;
        mapping.centerAgreed = false;
        mapping.programAgreed = false;
        await manager.save(ProjectMapping, mapping);

        // Record reopened event
        const event = new MappingNegotiation();
        event.mappingId = mapping.id;
        event.actorId = user.id;
        event.actorRole = 'center_rep';
        event.eventType = NegotiationEventType.REOPENED;
        await manager.save(MappingNegotiation, event);
      }

      this.logger.log(
        `Project ${projectId} round reopened by center rep ${user.id} (${lockedMappings.length} mappings)`,
      );

      return manager.find(ProjectMapping, {
        where: { projectId },
        relations: ['project', 'project.center', 'program', 'initiatedBy'],
        order: { createdAt: 'ASC' },
      });
    });
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

    /* Role-based access scoping */
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
    /* Admin sees everything */

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
    const allAgreed = active.every(
      (m) =>
        m.status === MappingStatus.AGREED || m.status === MappingStatus.LOCKED,
    );
    const allLocked =
      active.length > 0 &&
      active.every((m) => m.status === MappingStatus.LOCKED);
    const isComplete = Math.abs(totalAllocated - 100) < 0.01 && allAgreed;

    return {
      totalAllocated,
      remaining: 100 - totalAllocated,
      isComplete,
      isLocked: allLocked,
      canLock:
        isComplete &&
        !allLocked &&
        active.every((m) => m.status === MappingStatus.AGREED),
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
   * - Admin: all mappings.
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
      user.role === UserRole.CENTER_REP &&
      user.centerId === project.centerId;
    const canSeeAll = user.role === UserRole.ADMIN || isOwningCenterRep;

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
    if (user.role === UserRole.ADMIN) return;

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
   * Returns the actor role for recording in the negotiation event.
   */
  private validateNegotiationAccess(
    mapping: ProjectMapping,
    user: User,
  ): 'center_rep' | 'program_rep' {
    if (
      user.role === UserRole.CENTER_REP &&
      user.centerId === mapping.project.centerId
    ) {
      return 'center_rep';
    }

    if (
      user.role === UserRole.PROGRAM_REP &&
      user.programId === mapping.programId
    ) {
      return 'program_rep';
    }

    throw new ForbiddenException(
      'You do not have access to negotiate this mapping',
    );
  }
}
