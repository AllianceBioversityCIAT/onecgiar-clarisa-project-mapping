import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Project } from './entities/project.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Country } from '../reference-data/entities/country.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectQueryDto } from './dto/project-query.dto';
import { ProjectStatus } from './enums/project-status.enum';

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
  ) {}

  /**
   * Creates a new project.
   *
   * Resolves the center and optional countries by their UUIDs,
   * then persists the project with the authenticated user as creator.
   *
   * @param dto - Validated creation payload.
   * @param userId - UUID of the authenticated user creating the project.
   * @returns The newly created project with relations loaded.
   * @throws NotFoundException if the specified center does not exist.
   * @throws ConflictException if a project with the same code already exists.
   */
  async create(dto: CreateProjectDto, userId: string): Promise<Project> {
    /* Verify center exists */
    const center = await this.centerRepository.findOneBy({ id: dto.centerId });
    if (!center) {
      throw new NotFoundException(`Center with ID "${dto.centerId}" not found`);
    }

    /* Check for duplicate project code */
    const existing = await this.projectRepository.findOneBy({ code: dto.code });
    if (existing) {
      throw new ConflictException(`Project with code "${dto.code}" already exists`);
    }

    /* Resolve countries if provided */
    let countries: Country[] = [];
    if (dto.countryIds?.length) {
      countries = await this.countryRepository.findBy({ id: In(dto.countryIds) });
      if (countries.length !== dto.countryIds.length) {
        throw new NotFoundException('One or more country IDs are invalid');
      }
    }

    const project = this.projectRepository.create({
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
    });

    const saved = await this.projectRepository.save(project);
    this.logger.log(`Project "${saved.code}" created with ID ${saved.id}`);

    return this.findOne(saved.id);
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
  ): Promise<{ data: Project[]; total: number; page: number; limit: number }> {
    const qb = this.projectRepository
      .createQueryBuilder('project')
      .leftJoinAndSelect('project.center', 'center');

    /* Free-text search across code, name, and description */
    if (query.search) {
      qb.andWhere(
        '(project.code LIKE :search OR project.name LIKE :search OR project.description LIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    /* Filter by center */
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

    /* Pagination */
    const offset = (query.page - 1) * query.limit;
    qb.orderBy('project.created_at', 'DESC')
      .offset(offset)
      .limit(query.limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page: query.page, limit: query.limit };
  }

  /**
   * Retrieves a single project by UUID with all relations loaded.
   *
   * @param id - Project UUID.
   * @returns The project with center, countries, and createdBy relations.
   * @throws NotFoundException if the project does not exist.
   */
  async findOne(id: string): Promise<Project> {
    const project = await this.projectRepository.findOne({
      where: { id },
      relations: ['center', 'countries', 'createdBy'],
    });

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
   * @param id - Project UUID.
   * @param dto - Validated update payload (partial).
   * @returns The updated project with relations loaded.
   * @throws NotFoundException if the project does not exist.
   * @throws ConflictException if updating the code to one that already exists.
   */
  async update(id: string, dto: UpdateProjectDto): Promise<Project> {
    const project = await this.projectRepository.findOne({
      where: { id },
      relations: ['countries'],
    });

    if (!project) {
      throw new NotFoundException(`Project with ID "${id}" not found`);
    }

    /* Validate unique code if being changed */
    if (dto.code && dto.code !== project.code) {
      const existing = await this.projectRepository.findOneBy({ code: dto.code });
      if (existing) {
        throw new ConflictException(`Project with code "${dto.code}" already exists`);
      }
    }

    /* Validate center if being changed */
    if (dto.centerId) {
      const center = await this.centerRepository.findOneBy({ id: dto.centerId });
      if (!center) {
        throw new NotFoundException(`Center with ID "${dto.centerId}" not found`);
      }
    }

    /* Resolve countries if provided */
    if (dto.countryIds !== undefined) {
      if (dto.countryIds.length) {
        const countries = await this.countryRepository.findBy({ id: In(dto.countryIds) });
        if (countries.length !== dto.countryIds.length) {
          throw new NotFoundException('One or more country IDs are invalid');
        }
        project.countries = countries;
      } else {
        project.countries = [];
      }
    }

    /* Apply scalar field updates */
    if (dto.code !== undefined) project.code = dto.code;
    if (dto.name !== undefined) project.name = dto.name;
    if (dto.description !== undefined) project.description = dto.description ?? null;
    if (dto.summary !== undefined) project.summary = dto.summary ?? null;
    if (dto.results !== undefined) project.results = dto.results ?? null;
    if (dto.startDate !== undefined) project.startDate = dto.startDate ? new Date(dto.startDate) : null;
    if (dto.endDate !== undefined) project.endDate = dto.endDate ? new Date(dto.endDate) : null;
    if (dto.totalBudget !== undefined) project.totalBudget = dto.totalBudget;
    if (dto.remainingBudget !== undefined) project.remainingBudget = dto.remainingBudget;
    if (dto.fundingSource !== undefined) project.fundingSource = dto.fundingSource ?? null;
    if (dto.funder !== undefined) project.funder = dto.funder ?? null;
    if (dto.centerId !== undefined) project.centerId = dto.centerId;

    await this.projectRepository.save(project);
    this.logger.log(`Project "${project.code}" (${id}) updated`);

    return this.findOne(id);
  }

  /**
   * Archives a project by setting its status to 'archived'.
   *
   * This is a soft-delete operation; the project record remains
   * in the database for audit and historical reference.
   *
   * @param id - Project UUID.
   * @throws NotFoundException if the project does not exist.
   */
  async archive(id: string): Promise<void> {
    const project = await this.projectRepository.findOneBy({ id });

    if (!project) {
      throw new NotFoundException(`Project with ID "${id}" not found`);
    }

    project.status = ProjectStatus.ARCHIVED;
    await this.projectRepository.save(project);
    this.logger.log(`Project "${project.code}" (${id}) archived`);
  }
}
