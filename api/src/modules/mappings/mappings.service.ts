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
import { Project } from '../projects/entities/project.entity';
import { Program } from '../reference-data/entities/program.entity';
import { CreateMappingDto } from './dto/create-mapping.dto';
import { UpdateMappingDto } from './dto/update-mapping.dto';
import { MappingQueryDto } from './dto/mapping-query.dto';
import { MappingStatus } from './enums/mapping-status.enum';
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
  mappings: Array<{
    programId: number;
    programName: string;
    allocation: number;
    status: MappingStatus;
  }>;
}

/**
 * Service handling project-to-program mapping business logic.
 *
 * Manages the full lifecycle: creation by program representatives,
 * allocation validation (total <= 100%), and approval/rejection by
 * center representatives.
 */
@Injectable()
export class MappingsService {
  private readonly logger = new Logger(MappingsService.name);

  constructor(
    @InjectRepository(ProjectMapping)
    private readonly mappingRepository: Repository<ProjectMapping>,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Program)
    private readonly programRepository: Repository<Program>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates a new project-to-program mapping.
   *
   * Uses a transaction with SELECT FOR UPDATE to prevent race conditions
   * when multiple programs submit allocations simultaneously. The program
   * is inferred from the authenticated user's profile.
   *
   * @param dto - Validated creation payload.
   * @param user - Authenticated user (must be a program representative).
   * @returns The created mapping with relations loaded.
   * @throws ForbiddenException if user is not a program_rep or has no programId.
   * @throws NotFoundException if the project does not exist or is not active.
   * @throws ConflictException if a mapping already exists for this project+program.
   * @throws BadRequestException if the allocation would exceed 100%.
   */
  async create(dto: CreateMappingDto, user: User): Promise<ProjectMapping> {
    /* Validate user is a program rep with an assigned program */
    if (user.role !== UserRole.PROGRAM_REP || !user.programId) {
      throw new ForbiddenException(
        'Only program representatives with an assigned program can create mappings',
      );
    }

    /* Validate project exists and is active */
    const project = await this.projectRepository.findOneBy({ id: dto.projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${dto.projectId}" not found`);
    }
    if (project.status !== ProjectStatus.ACTIVE) {
      throw new BadRequestException('Mappings can only be created for active projects');
    }

    /* Check for existing mapping for this project+program (unique constraint) */
    const existing = await this.mappingRepository.findOneBy({
      projectId: dto.projectId,
      programId: user.programId,
    });

    if (existing && existing.status !== MappingStatus.REJECTED) {
      throw new ConflictException('Mapping already exists for this project and program');
    }

    /* Use a transaction with locking to prevent allocation race conditions */
    return this.dataSource.transaction(async (manager) => {
      /* Lock existing non-rejected mappings for this project */
      const existingMappings = await manager
        .createQueryBuilder(ProjectMapping, 'mapping')
        .setLock('pessimistic_write')
        .where('mapping.projectId = :projectId', { projectId: dto.projectId })
        .andWhere('mapping.status != :rejected', { rejected: MappingStatus.REJECTED })
        .getMany();

      /* Calculate current total allocation */
      const currentTotal = existingMappings.reduce(
        (sum, m) => sum + Number(m.allocationPercentage),
        0,
      );

      if (currentTotal + dto.allocationPercentage > 100) {
        const remaining = 100 - currentTotal;
        throw new BadRequestException(
          `Allocation would exceed 100% for this project. Currently allocated: ${currentTotal}%, remaining: ${remaining}%`,
        );
      }

      let saved: ProjectMapping;

      if (existing) {
        /* Reuse the rejected mapping row to satisfy the unique constraint */
        existing.allocationPercentage = dto.allocationPercentage;
        existing.complementarityRating = dto.complementarityRating ?? null;
        existing.efficiencyRating = dto.efficiencyRating ?? null;
        existing.status = MappingStatus.PENDING;
        existing.submittedById = user.id;
        existing.submittedAt = new Date();
        existing.reviewedById = null;
        existing.reviewedAt = null;
        existing.rejectionReason = null;
        saved = await manager.save(ProjectMapping, existing);
        this.logger.log(
          `Mapping resubmitted: project=${dto.projectId}, program=${user.programId}, allocation=${dto.allocationPercentage}%`,
        );
      } else {
        /* Create a new mapping */
        const mapping = new ProjectMapping();
        mapping.projectId = dto.projectId;
        mapping.programId = user.programId!;
        mapping.allocationPercentage = dto.allocationPercentage;
        mapping.complementarityRating = dto.complementarityRating ?? null;
        mapping.efficiencyRating = dto.efficiencyRating ?? null;
        mapping.status = MappingStatus.PENDING;
        mapping.submittedById = user.id;
        mapping.submittedAt = new Date();
        saved = await manager.save(ProjectMapping, mapping);
        this.logger.log(
          `Mapping created: project=${dto.projectId}, program=${user.programId}, allocation=${dto.allocationPercentage}%`,
        );
      }

      /* Load with relations using the transaction manager (not the
         default repository, which can't see uncommitted rows). */
      const loaded = await manager.findOne(ProjectMapping, {
        where: { id: saved.id },
        relations: ['project', 'program', 'submittedBy', 'reviewedBy'],
      });
      return loaded!;
    });
  }

  /**
   * Retrieves a paginated list of mappings with role-based filtering.
   *
   * - Admin: sees all mappings.
   * - Program rep: sees only mappings for their program.
   * - Center rep: sees mappings for projects belonging to their center.
   *
   * @param query - Filter, search, and pagination parameters.
   * @param user - Authenticated user for role-based scoping.
   * @returns Paginated result with data array and metadata.
   */
  async findAll(
    query: MappingQueryDto,
    user: User,
  ): Promise<{ data: ProjectMapping[]; total: number; page: number; limit: number }> {
    const qb = this.mappingRepository
      .createQueryBuilder('mapping')
      .leftJoinAndSelect('mapping.project', 'project')
      .leftJoinAndSelect('mapping.program', 'program')
      .leftJoinAndSelect('mapping.submittedBy', 'submitter')
      .leftJoinAndSelect('mapping.reviewedBy', 'reviewer');

    /* Role-based access scoping */
    if (user.role === UserRole.PROGRAM_REP) {
      qb.andWhere('mapping.programId = :userProgramId', { userProgramId: user.programId });
    } else if (user.role === UserRole.CENTER_REP) {
      qb.andWhere('project.centerId = :userCenterId', { userCenterId: user.centerId });
    }
    /* Admin sees everything — no additional WHERE clause */

    /* Optional filters */
    if (query.status) {
      qb.andWhere('mapping.status = :status', { status: query.status });
    }
    if (query.programId) {
      qb.andWhere('mapping.programId = :programId', { programId: query.programId });
    }
    if (query.projectId) {
      qb.andWhere('mapping.projectId = :projectId', { projectId: query.projectId });
    }
    if (query.search) {
      qb.andWhere('project.name LIKE :search', { search: `%${query.search}%` });
    }

    /* Pagination */
    const offset = (query.page - 1) * query.limit;
    qb.orderBy('mapping.created_at', 'DESC').offset(offset).limit(query.limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Retrieves a single mapping by ID with access control.
   *
   * @param id - Mapping ID.
   * @param user - Authenticated user for access validation.
   * @returns The mapping with all relations loaded.
   * @throws NotFoundException if the mapping does not exist.
   * @throws ForbiddenException if the user lacks access.
   */
  async findOne(id: number, user: User): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(id);
    this.checkReadAccess(mapping, user);
    return mapping;
  }

  /**
   * Updates an existing pending or rejected mapping.
   *
   * Only the original submitter can update a mapping. When updating
   * a rejected mapping, the status is reset to 'pending' for re-review
   * and the review fields are cleared.
   *
   * @param id - Mapping ID.
   * @param dto - Validated update payload.
   * @param user - Authenticated user (must be the submitter).
   * @returns The updated mapping with relations loaded.
   * @throws NotFoundException if the mapping does not exist.
   * @throws ForbiddenException if user is not the submitter.
   * @throws BadRequestException if the mapping is approved or allocation exceeds 100%.
   */
  async update(id: number, dto: UpdateMappingDto, user: User): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(id);

    /* Only the submitter can update */
    if (mapping.submittedById !== user.id) {
      throw new ForbiddenException('Only the submitter can update this mapping');
    }

    /* Can only update pending or rejected mappings */
    if (mapping.status === MappingStatus.APPROVED) {
      throw new BadRequestException('Cannot update an approved mapping');
    }

    /* Validate allocation if being changed */
    if (dto.allocationPercentage !== undefined) {
      await this.validateAllocation(
        mapping.projectId,
        dto.allocationPercentage,
        mapping.id,
      );
    }

    /* Apply updates */
    if (dto.allocationPercentage !== undefined) {
      mapping.allocationPercentage = dto.allocationPercentage;
    }
    if (dto.complementarityRating !== undefined) {
      mapping.complementarityRating = dto.complementarityRating ?? null;
    }
    if (dto.efficiencyRating !== undefined) {
      mapping.efficiencyRating = dto.efficiencyRating ?? null;
    }

    /* If mapping was rejected, resubmit it */
    if (mapping.status === MappingStatus.REJECTED) {
      mapping.status = MappingStatus.PENDING;
      mapping.reviewedById = null;
      mapping.reviewedAt = null;
      this.logger.log(`Mapping ${id} resubmitted after rejection`);
    }

    await this.mappingRepository.save(mapping);
    this.logger.log(`Mapping ${id} updated`);

    return this.findOneInternal(id);
  }

  /**
   * Deletes a pending mapping.
   *
   * Only the original submitter can delete, and only while the
   * mapping is still pending. This is a hard delete since pending
   * mappings are not historical data.
   *
   * @param id - Mapping ID.
   * @param user - Authenticated user (must be the submitter).
   * @throws NotFoundException if the mapping does not exist.
   * @throws ForbiddenException if user is not the submitter.
   * @throws BadRequestException if the mapping is not pending.
   */
  async remove(id: number, user: User): Promise<void> {
    const mapping = await this.findOneInternal(id);

    if (mapping.submittedById !== user.id) {
      throw new ForbiddenException('Only the submitter can delete this mapping');
    }

    if (mapping.status !== MappingStatus.PENDING) {
      throw new BadRequestException('Only pending mappings can be deleted');
    }

    await this.mappingRepository.remove(mapping);
    this.logger.log(`Mapping ${id} deleted by user ${user.id}`);
  }

  /**
   * Returns the allocation summary for a project.
   *
   * Shows how much of the project has been claimed by various
   * programs and what percentage remains available.
   *
   * @param projectId - ID of the project.
   * @returns Allocation breakdown with total, remaining, and per-program details.
   * @throws NotFoundException if the project does not exist.
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

    /* Only count non-rejected mappings toward the total */
    const nonRejected = mappings.filter((m) => m.status !== MappingStatus.REJECTED);
    const totalAllocated = nonRejected.reduce(
      (sum, m) => sum + Number(m.allocationPercentage),
      0,
    );

    return {
      totalAllocated,
      remaining: 100 - totalAllocated,
      isComplete: totalAllocated === 100,
      mappings: mappings.map((m) => ({
        programId: m.programId,
        programName: m.program.name,
        allocation: Number(m.allocationPercentage),
        status: m.status,
      })),
    };
  }

  // ─── Wave 5: Approval Workflow ────────────────────────────────────

  /**
   * Approves a pending mapping.
   *
   * Only center representatives whose center owns the mapped project
   * can approve. All non-rejected allocations for the project must
   * total exactly 100% before approval is allowed.
   *
   * @param id - Mapping ID.
   * @param user - Authenticated center representative.
   * @returns The approved mapping with relations loaded.
   * @throws NotFoundException if the mapping does not exist.
   * @throws BadRequestException if the mapping is already reviewed.
   * @throws ForbiddenException if user is not a center_rep or center mismatch.
   * @throws BadRequestException if total allocation is not 100%.
   */
  async approve(id: number, user: User): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(id);

    this.validateReviewEligibility(mapping, user);

    /* Validate total allocation is 100% */
    const summary = await this.getAllocationSummary(mapping.projectId);
    if (!summary.isComplete) {
      throw new BadRequestException(
        `Cannot approve until all allocations total 100%. Currently at ${summary.totalAllocated}%`,
      );
    }

    mapping.status = MappingStatus.APPROVED;
    mapping.reviewedById = user.id;
    mapping.reviewedAt = new Date();

    await this.mappingRepository.save(mapping);
    this.logger.log(
      `Mapping ${id} approved by center rep ${user.id} for project ${mapping.projectId}`,
    );

    return this.findOneInternal(id);
  }

  /**
   * Rejects a pending mapping with a required reason.
   *
   * Only center representatives whose center owns the mapped project
   * can reject. The reason is stored for the program representative
   * to review before resubmission.
   *
   * @param id - Mapping ID.
   * @param reason - Rejection reason (minimum 10 characters).
   * @param user - Authenticated center representative.
   * @returns The rejected mapping with relations loaded.
   * @throws NotFoundException if the mapping does not exist.
   * @throws BadRequestException if the mapping is already reviewed.
   * @throws ForbiddenException if user is not a center_rep or center mismatch.
   */
  async reject(id: number, reason: string, user: User): Promise<ProjectMapping> {
    const mapping = await this.findOneInternal(id);

    this.validateReviewEligibility(mapping, user);

    mapping.status = MappingStatus.REJECTED;
    mapping.rejectionReason = reason;
    mapping.reviewedById = user.id;
    mapping.reviewedAt = new Date();

    await this.mappingRepository.save(mapping);
    this.logger.log(
      `Mapping ${id} rejected by center rep ${user.id} for project ${mapping.projectId}`,
    );

    return this.findOneInternal(id);
  }

  /**
   * Returns the review summary for a project's mappings.
   *
   * Accessible to admins and center representatives whose center
   * owns the project. Returns all mappings with full relation details.
   *
   * @param projectId - ID of the project.
   * @param user - Authenticated user (admin or matching center rep).
   * @returns All mappings for the project with full details.
   * @throws NotFoundException if the project does not exist.
   * @throws ForbiddenException if user lacks access.
   */
  async getReviewSummary(projectId: number, user: User): Promise<ProjectMapping[]> {
    const project = await this.projectRepository.findOneBy({ id: projectId });
    if (!project) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    /* Access control: admin or matching center rep */
    if (user.role === UserRole.CENTER_REP && user.centerId !== project.centerId) {
      throw new ForbiddenException('You can only view review summaries for projects in your center');
    }

    return this.mappingRepository.find({
      where: { projectId },
      relations: ['project', 'program', 'submittedBy', 'reviewedBy'],
      order: { createdAt: 'ASC' },
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────

  /**
   * Loads a mapping by ID with all relations. Throws if not found.
   */
  private async findOneInternal(id: number): Promise<ProjectMapping> {
    const mapping = await this.mappingRepository.findOne({
      where: { id },
      relations: ['project', 'program', 'submittedBy', 'reviewedBy'],
    });

    if (!mapping) {
      throw new NotFoundException(`Mapping with ID "${id}" not found`);
    }

    return mapping;
  }

  /**
   * Checks that the user has read access to the given mapping
   * based on their role and organizational affiliation.
   */
  private checkReadAccess(mapping: ProjectMapping, user: User): void {
    if (user.role === UserRole.ADMIN) return;

    if (user.role === UserRole.PROGRAM_REP && mapping.programId === user.programId) return;

    if (user.role === UserRole.CENTER_REP && mapping.project.centerId === user.centerId) return;

    throw new ForbiddenException('You do not have access to this mapping');
  }

  /**
   * Validates that adding a given allocation (excluding a specific mapping)
   * would not exceed 100% total for the project.
   */
  private async validateAllocation(
    projectId: number,
    newPercentage: number,
    excludeMappingId: number,
  ): Promise<void> {
    const existingMappings = await this.mappingRepository
      .createQueryBuilder('mapping')
      .where('mapping.projectId = :projectId', { projectId })
      .andWhere('mapping.status != :rejected', { rejected: MappingStatus.REJECTED })
      .andWhere('mapping.id != :excludeId', { excludeId: excludeMappingId })
      .getMany();

    const currentTotal = existingMappings.reduce(
      (sum, m) => sum + Number(m.allocationPercentage),
      0,
    );

    if (currentTotal + newPercentage > 100) {
      const remaining = 100 - currentTotal;
      throw new BadRequestException(
        `Allocation would exceed 100% for this project. Currently allocated: ${currentTotal}%, remaining: ${remaining}%`,
      );
    }
  }

  /**
   * Validates that a mapping can be reviewed (approved/rejected)
   * by the given user. Shared by approve() and reject().
   */
  private validateReviewEligibility(mapping: ProjectMapping, user: User): void {
    if (mapping.status !== MappingStatus.PENDING) {
      throw new BadRequestException('Mapping is already reviewed');
    }

    if (user.role !== UserRole.CENTER_REP) {
      throw new ForbiddenException('Only center representatives can review mappings');
    }

    if (user.centerId !== mapping.project.centerId) {
      throw new ForbiddenException(
        'You can only review mappings for projects in your center',
      );
    }
  }
}
