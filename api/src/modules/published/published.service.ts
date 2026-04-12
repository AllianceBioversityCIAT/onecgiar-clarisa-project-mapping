import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PublishedSnapshot } from './entities/published-snapshot.entity';
import { PublishedProject } from './entities/published-project.entity';
import { PublishedMappingData } from './entities/published-mapping.interface';
import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { MappingStatus } from '../mappings/enums/mapping-status.enum';
import { CreateSnapshotDto } from './dto/create-snapshot.dto';
import { PublishedProjectQueryDto } from './dto/published-project-query.dto';

@Injectable()
export class PublishedService {
  private readonly logger = new Logger(PublishedService.name);

  constructor(
    @InjectRepository(PublishedSnapshot)
    private readonly snapshotRepo: Repository<PublishedSnapshot>,
    @InjectRepository(PublishedProject)
    private readonly publishedProjectRepo: Repository<PublishedProject>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectMapping)
    private readonly mappingRepo: Repository<ProjectMapping>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates a new published snapshot from current active projects
   * and their approved mappings. Deactivates any previous active snapshot.
   */
  async createSnapshot(
    userId: number,
    dto: CreateSnapshotDto,
  ): Promise<PublishedSnapshot> {
    return this.dataSource.transaction(async (manager) => {
      /* Deactivate all currently active snapshots */
      await manager
        .createQueryBuilder()
        .update(PublishedSnapshot)
        .set({ isActive: false })
        .where('is_active = 1')
        .execute();

      /* Load all active projects with center + countries */
      const projects = await this.projectRepo
        .createQueryBuilder('project')
        .leftJoinAndSelect('project.center', 'center')
        .leftJoinAndSelect('project.countries', 'countries')
        .where('project.status = :status', { status: ProjectStatus.ACTIVE })
        .getMany();

      /* Load all approved mappings for active projects with program relation */
      const projectIds = projects.map((p) => p.id);
      let mappings: ProjectMapping[] = [];
      if (projectIds.length > 0) {
        mappings = await this.mappingRepo
          .createQueryBuilder('mapping')
          .leftJoinAndSelect('mapping.program', 'program')
          .where('mapping.projectId IN (:...projectIds)', { projectIds })
          .andWhere('mapping.status = :status', {
            status: MappingStatus.APPROVED,
          })
          .getMany();
      }

      /* Group mappings by project ID */
      const mappingsByProject = new Map<number, ProjectMapping[]>();
      for (const m of mappings) {
        const list = mappingsByProject.get(m.projectId) || [];
        list.push(m);
        mappingsByProject.set(m.projectId, list);
      }

      /* Compute summary stats */
      const centerCounts = new Map<string, { name: string; count: number }>();
      const programCounts = new Map<string, { name: string; count: number }>();
      let totalBudget = 0;

      for (const project of projects) {
        totalBudget += Number(project.totalBudget) || 0;

        const acronym = project.center?.acronym || 'Unknown';
        const centerEntry = centerCounts.get(acronym) || {
          name: project.center?.name || 'Unknown',
          count: 0,
        };
        centerEntry.count++;
        centerCounts.set(acronym, centerEntry);

        const projectMappings = mappingsByProject.get(project.id) || [];
        for (const mapping of projectMappings) {
          const code = mapping.program?.officialCode || 'Unknown';
          const programEntry = programCounts.get(code) || {
            name: mapping.program?.name || 'Unknown',
            count: 0,
          };
          programEntry.count++;
          programCounts.set(code, programEntry);
        }
      }

      const summaryStats = {
        projectsByCenter: Array.from(centerCounts.entries()).map(
          ([acronym, { name, count }]) => ({ acronym, name, count }),
        ),
        projectsByProgram: Array.from(programCounts.entries()).map(
          ([code, { name, count }]) => ({ code, name, count }),
        ),
      };

      /* Create snapshot entity */
      const snapshot = manager.create(PublishedSnapshot, {
        versionLabel: dto.versionLabel,
        description: dto.description || null,
        publishedAt: new Date(),
        publishedById: userId,
        projectCount: projects.length,
        totalBudget,
        summaryStats,
        isActive: true,
      });

      const savedSnapshot = await manager.save(PublishedSnapshot, snapshot);

      /* Create published project rows */
      const publishedProjects = projects.map((project) => {
        const projectMappings = mappingsByProject.get(project.id) || [];
        const mappingsData: PublishedMappingData[] = projectMappings.map(
          (m) => ({
            programName: m.program?.name || '',
            programCode: m.program?.officialCode || '',
            allocationPercentage: Number(m.allocationPercentage),
            complementarityRating: m.complementarityRating,
            efficiencyRating: m.efficiencyRating,
          }),
        );

        return manager.create(PublishedProject, {
          snapshotId: savedSnapshot.id,
          sourceProjectId: project.id,
          code: project.code,
          name: project.name,
          description: project.description,
          centerName: project.center?.name || '',
          centerAcronym: project.center?.acronym || '',
          countries: (project.countries || []).map((c) => ({
            name: c.name,
            isoAlpha2: c.isoAlpha2,
          })),
          totalBudget: Number(project.totalBudget) || 0,
          fundingSource: project.fundingSource,
          funder: project.funder,
          status: project.status,
          startDate: project.startDate,
          endDate: project.endDate,
          mappings: mappingsData,
        });
      });

      if (publishedProjects.length > 0) {
        await manager.save(PublishedProject, publishedProjects);
      }

      this.logger.log(
        `Snapshot "${dto.versionLabel}" created with ${projects.length} projects`,
      );

      return savedSnapshot;
    });
  }

  /** Returns the latest active snapshot (metadata only, no projects). */
  async getLatestSnapshot(): Promise<PublishedSnapshot | null> {
    return this.snapshotRepo.findOne({
      where: { isActive: true as unknown as boolean },
      order: { publishedAt: 'DESC' },
      relations: ['publishedBy'],
    });
  }

  /** Paginated published projects for a given snapshot. */
  async getPublishedProjects(
    snapshotId: number,
    query: PublishedProjectQueryDto,
  ): Promise<{
    data: PublishedProject[];
    total: number;
    page: number;
    limit: number;
  }> {
    const qb = this.publishedProjectRepo
      .createQueryBuilder('pp')
      .where('pp.snapshotId = :snapshotId', { snapshotId });

    if (query.search) {
      qb.andWhere(
        '(pp.code LIKE :search OR pp.name LIKE :search OR pp.centerName LIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    if (query.center) {
      qb.andWhere('pp.centerAcronym = :center', { center: query.center });
    }

    const offset = (query.page - 1) * query.limit;
    qb.orderBy('pp.code', 'ASC').offset(offset).limit(query.limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page: query.page, limit: query.limit };
  }

  /** Lists all snapshots ordered by most recent first. */
  async listSnapshots(): Promise<PublishedSnapshot[]> {
    return this.snapshotRepo.find({
      order: { publishedAt: 'DESC' },
      relations: ['publishedBy'],
    });
  }
}
