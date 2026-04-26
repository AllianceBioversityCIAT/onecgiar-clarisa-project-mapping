import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In } from 'typeorm';
import { Project } from './entities/project.entity';
import { ProjectBudget } from './entities/project-budget.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Country } from '../reference-data/entities/country.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectQueryDto } from './dto/project-query.dto';
import { ProjectStatus } from './enums/project-status.enum';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';

/**
 * Service handling all project-related business logic.
 *
 * Manages CRUD operations, pagination, search, and filtering
 * for the projects domain.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(Center)
    private readonly centerRepository: Repository<Center>,
    @InjectRepository(Country)
    private readonly countryRepository: Repository<Country>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates a new project.
   *
   * Resolves the center and optional countries by their IDs,
   * then persists the project with the authenticated user as creator.
   *
   * @param dto - Validated creation payload.
   * @param userId - ID of the authenticated user creating the project.
   * @returns The newly created project with relations loaded.
   * @throws NotFoundException if the specified center does not exist.
   * @throws ConflictException if a project with the same code already exists.
   */
  async create(dto: CreateProjectDto, userId: number): Promise<Project> {
    /* Verify center exists */
    const center = await this.centerRepository.findOneBy({ id: dto.centerId });
    if (!center) {
      throw new NotFoundException(`Center with ID "${dto.centerId}" not found`);
    }

    /* Check for duplicate project code */
    const existing = await this.projectRepository.findOneBy({ code: dto.code });
    if (existing) {
      throw new ConflictException(
        `Project with code "${dto.code}" already exists`,
      );
    }

    /* Resolve countries if provided */
    let countries: Country[] = [];
    if (dto.countryIds?.length) {
      countries = await this.countryRepository.findBy({
        id: In(dto.countryIds),
      });
      if (countries.length !== dto.countryIds.length) {
        throw new NotFoundException('One or more country IDs are invalid');
      }
    }

    /* Persist project + budget lines atomically. The transaction guarantees
     * that a partial failure inserting budget rows rolls back the project
     * itself, preventing an orphaned project with no budget breakdown. */
    const savedId = await this.dataSource.transaction(async (manager) => {
      const project = manager.create(Project, {
        code: dto.code,
        name: dto.name,
        description: dto.description ?? null,
        summary: dto.summary ?? null,
        results: dto.results ?? null,
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        totalBudget: dto.totalBudget,
        remainingBudget: dto.remainingBudget ?? dto.totalBudget,
        fundingSource: dto.fundingSource ?? null,
        funder: dto.funder ?? null,
        centerId: dto.centerId,
        createdById: userId,
        countries,
        /* Optional 4.1 Project Info fields. */
        funderPrimaryCenter: dto.funderPrimaryCenter ?? null,
        natureOfFunder: dto.natureOfFunder ?? null,
        category: dto.category ?? null,
        csp: dto.csp ?? null,
        cspNonCollectionReason: dto.cspNonCollectionReason ?? null,
        totalPledge: dto.totalPledge ?? null,
        principalInvestigator: dto.principalInvestigator ?? null,
        signedContractTitle: dto.signedContractTitle ?? null,
      });

      /* Attach budget lines via cascade — TypeORM will insert them in the
       * same transaction once the project has its generated ID. */
      if (dto.budgets?.length) {
        project.budgets = dto.budgets.map((b) =>
          manager.create(ProjectBudget, {
            year: b.year,
            version: b.version,
            account: b.account,
            amount: b.amount,
            externalCode: b.externalCode ?? null,
          }),
        );
      }

      const saved = await manager.save(project);
      this.logger.log(`Project "${saved.code}" created with ID ${saved.id}`);
      return saved.id;
    });

    return this.findOne(savedId);
  }

  /**
   * Retrieves a paginated list of projects with optional search and filters.
   *
   * Uses QueryBuilder for efficient filtering, search, and pagination.
   * Results are ordered by creation date descending (newest first).
   *
   * @param query - Search, filter, and pagination parameters.
   * @returns Paginated result with data array and metadata.
   */
  async findAll(
    query: ProjectQueryDto,
    user?: User,
  ): Promise<{
    data: Array<Project & { needsAssistanceMappingCount: number }>;
    total: number;
    page: number;
    limit: number;
  }> {
    /* Authorize the needsAssistance filter up front — only workflow_admin
     * may use it, since this is the workflow admin's triage queue.
     * Throwing here keeps the error close to the permission check rather
     * than letting it bubble through SQL. */
    if (
      query.needsAssistance === true &&
      user?.role !== UserRole.WORKFLOW_ADMIN
    ) {
      throw new ForbiddenException(
        'Only workflow admins can filter by needsAssistance',
      );
    }

    const qb = this.projectRepository
      .createQueryBuilder('project')
      .leftJoinAndSelect('project.center', 'center')
      /* Always expose a derived count of flagged mappings on each project
       * so the UI can badge rows that need workflow-admin attention. The
       * correlated subquery keeps this cheap (a single COUNT per row,
       * served by IDX_project_mappings_project_needs_assistance). */
      .addSelect(
        `(
          SELECT COUNT(*)
          FROM project_mappings pm_count
          WHERE pm_count.project_id = project.id
            AND pm_count.needs_assistance = 1
        )`,
        'needs_assistance_mapping_count',
      );

    /* Center reps only see projects belonging to their center */
    if (user?.role === UserRole.CENTER_REP && user.centerId) {
      qb.andWhere('project.centerId = :userCenterId', {
        userCenterId: user.centerId,
      });
    }

    /* Free-text search across code, name, and description */
    if (query.search) {
      qb.andWhere(
        '(project.code LIKE :search OR project.name LIKE :search OR project.description LIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    /* Filter by center (admin/other roles can still use the dropdown filter) */
    if (query.centerId) {
      qb.andWhere('project.centerId = :centerId', { centerId: query.centerId });
    }

    /* Filter by status */
    if (query.status) {
      qb.andWhere('project.status = :status', { status: query.status });
    }

    /* Filter by funding source */
    if (query.fundingSource) {
      qb.andWhere('project.fundingSource = :fundingSource', {
        fundingSource: query.fundingSource,
      });
    }

    /* Restrict to projects with at least one flagged mapping. Admin /
     * workflow_admin only; the auth guard above already enforced that. */
    if (query.needsAssistance === true) {
      qb.andWhere(
        `EXISTS (
          SELECT 1
          FROM project_mappings pm_flag
          WHERE pm_flag.project_id = project.id
            AND pm_flag.needs_assistance = 1
        )`,
      );
    }

    /* Pagination */
    const offset = (query.page - 1) * query.limit;
    qb.orderBy('project.created_at', 'DESC').offset(offset).limit(query.limit);

    /* getRawAndEntities lets us merge the addSelect-ed count back onto
     * each hydrated entity. getCount() is a separate cheap query so we
     * don't lose the offset/limit pagination. */
    const [{ entities, raw }, total] = await Promise.all([
      qb.getRawAndEntities(),
      qb.getCount(),
    ]);

    const data = entities.map((entity, idx) => {
      const rawRow = raw[idx] as
        | { needs_assistance_mapping_count?: string | number | null }
        | undefined;
      const count = Number(rawRow?.needs_assistance_mapping_count ?? 0);
      return Object.assign(entity, {
        needsAssistanceMappingCount: Number.isFinite(count) ? count : 0,
      });
    });

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Retrieves a single project by ID with all relations loaded.
   *
   * @param id - Project ID.
   * @returns The project with center, countries, and createdBy relations.
   * @throws NotFoundException if the project does not exist.
   */
  async findOne(id: number): Promise<Project> {
    /* QueryBuilder lets us leftJoinAndSelect the budgets collection and
     * apply an ORDER BY to the joined rows (year asc, then account asc)
     * for a deterministic presentation order in the detail view. */
    const project = await this.projectRepository
      .createQueryBuilder('project')
      .leftJoinAndSelect('project.center', 'center')
      .leftJoinAndSelect('project.countries', 'countries')
      .leftJoinAndSelect('project.createdBy', 'createdBy')
      .leftJoinAndSelect('project.budgets', 'budgets')
      .where('project.id = :id', { id })
      .orderBy('budgets.year', 'ASC')
      .addOrderBy('budgets.account', 'ASC')
      .getOne();

    if (!project) {
      throw new NotFoundException(`Project with ID "${id}" not found`);
    }

    return project;
  }

  /**
   * Updates an existing project.
   *
   * Handles partial updates including country relation replacement
   * when `countryIds` is provided.
   *
   * @param id - Project ID.
   * @param dto - Validated update payload (partial).
   * @returns The updated project with relations loaded.
   * @throws NotFoundException if the project does not exist.
   * @throws ConflictException if updating the code to one that already exists.
   */
  async update(id: number, dto: UpdateProjectDto): Promise<Project> {
    /* Load project with both countries and budgets so we have the full
     * existing state before the diff runs. Everything happens inside a
     * single transaction to ensure consistent multi-row writes. */
    await this.dataSource.transaction(async (manager) => {
      const project = await manager.findOne(Project, {
        where: { id },
        relations: ['countries', 'budgets'],
      });

      if (!project) {
        throw new NotFoundException(`Project with ID "${id}" not found`);
      }

      /* Validate unique code if being changed */
      if (dto.code && dto.code !== project.code) {
        const existing = await manager.findOneBy(Project, { code: dto.code });
        if (existing) {
          throw new ConflictException(
            `Project with code "${dto.code}" already exists`,
          );
        }
      }

      /* Validate center if being changed */
      if (dto.centerId) {
        const center = await manager.findOneBy(Center, { id: dto.centerId });
        if (!center) {
          throw new NotFoundException(
            `Center with ID "${dto.centerId}" not found`,
          );
        }
      }

      /* Strip Anaplan-sourced fields — these are managed exclusively via CSV
       * import and must not be overwritten through the update endpoint. This
       * is a defence-in-depth measure; the DTO already omits these fields,
       * but a raw API call bypassing class-validator could still sneak them
       * through, so we delete them from the object before applying updates. */
      const ANAPLAN_FIELDS = [
        'funderPrimaryCenter',
        'natureOfFunder',
        'category',
        'csp',
        'cspNonCollectionReason',
        'totalPledge',
        'principalInvestigator',
        'signedContractTitle',
      ] as const;
      for (const key of ANAPLAN_FIELDS) {
        delete (dto as any)[key];
      }

      /* Resolve countries if provided */
      if (dto.countryIds !== undefined) {
        if (dto.countryIds.length) {
          const countries = await manager.findBy(Country, {
            id: In(dto.countryIds),
          });
          if (countries.length !== dto.countryIds.length) {
            throw new NotFoundException('One or more country IDs are invalid');
          }
          project.countries = countries;
        } else {
          project.countries = [];
        }
      }

      /* Apply scalar field updates — existing fields. */
      if (dto.code !== undefined) project.code = dto.code;
      if (dto.name !== undefined) project.name = dto.name;
      if (dto.description !== undefined)
        project.description = dto.description ?? null;
      if (dto.summary !== undefined) project.summary = dto.summary ?? null;
      if (dto.results !== undefined) project.results = dto.results ?? null;
      if (dto.startDate !== undefined)
        project.startDate = dto.startDate ? new Date(dto.startDate) : null;
      if (dto.endDate !== undefined)
        project.endDate = dto.endDate ? new Date(dto.endDate) : null;
      if (dto.totalBudget !== undefined) project.totalBudget = dto.totalBudget;
      if (dto.remainingBudget !== undefined)
        project.remainingBudget = dto.remainingBudget;
      if (dto.fundingSource !== undefined)
        project.fundingSource = dto.fundingSource ?? null;
      if (dto.funder !== undefined) project.funder = dto.funder ?? null;
      if (dto.centerId !== undefined) project.centerId = dto.centerId;

      /* Budget diff: update rows with a matching id, insert new rows with
       * no id, and delete existing rows that are missing from the payload.
       * When dto.budgets is undefined we leave the budget collection
       * untouched (consistent with countries/countryIds semantics). */
      if (dto.budgets !== undefined) {
        const existingBudgets = project.budgets ?? [];
        const incomingById = new Map<number, (typeof dto.budgets)[number]>();
        const toInsert: (typeof dto.budgets)[number][] = [];

        for (const row of dto.budgets) {
          if (row.id != null) {
            incomingById.set(row.id, row);
          } else {
            toInsert.push(row);
          }
        }

        /* Delete existing rows that are no longer in the payload.
         * manager.remove() nullifies FK columns before deleting, which
         * violates the NOT NULL constraint on project_id. Use manager.delete()
         * with explicit IDs instead — it issues a direct DELETE statement
         * without the nullification step. */
        const toDelete = existingBudgets
          .filter((b) => !incomingById.has(b.id))
          .map((b) => b.id);
        if (toDelete.length) {
          await manager.delete(ProjectBudget, toDelete);
        }

        /* Update existing rows in place. */
        for (const existing of existingBudgets) {
          const match = incomingById.get(existing.id);
          if (!match) continue;
          existing.year = match.year;
          existing.version = match.version;
          existing.account = match.account;
          existing.amount = match.amount;
          existing.externalCode = match.externalCode ?? null;
          await manager.save(ProjectBudget, existing);
        }

        /* Insert brand new rows. */
        for (const row of toInsert) {
          const created = manager.create(ProjectBudget, {
            projectId: project.id,
            year: row.year,
            version: row.version,
            account: row.account,
            amount: row.amount,
            externalCode: row.externalCode ?? null,
          });
          await manager.save(ProjectBudget, created);
        }

        /* Detach the in-memory budgets collection from the project so the
         * final parent save() does NOT cascade back through the now-stale
         * array and overwrite (or nullify) rows we just hand-managed above.
         * The actual child rows in DB are already in their correct state. */
        (project as { budgets?: ProjectBudget[] }).budgets = undefined;
      }

      await manager.save(Project, project);
      this.logger.log(`Project "${project.code}" (${id}) updated`);
    });

    return this.findOne(id);
  }

  /**
   * Archives a project by setting its status to 'archived'.
   *
   * This is a soft-delete operation; the project record remains
   * in the database for audit and historical reference.
   *
   * @param id - Project ID.
   * @throws NotFoundException if the project does not exist.
   */
  async archive(id: number): Promise<void> {
    const project = await this.projectRepository.findOneBy({ id });

    if (!project) {
      throw new NotFoundException(`Project with ID "${id}" not found`);
    }

    project.status = ProjectStatus.ARCHIVED;
    await this.projectRepository.save(project);
    this.logger.log(`Project "${project.code}" (${id}) archived`);
  }
}
