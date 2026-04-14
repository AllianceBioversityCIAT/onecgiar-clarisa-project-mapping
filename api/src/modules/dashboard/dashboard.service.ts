import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { MappingNegotiation } from '../mappings/entities/mapping-negotiation.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Program } from '../reference-data/entities/program.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { MappingStatus } from '../mappings/enums/mapping-status.enum';

/** Cache time-to-live: 2 minutes in milliseconds. */
const CACHE_TTL_MS = 2 * 60 * 1000;

/** Cache entry with data payload and expiry timestamp. */
interface CacheEntry<T> {
  data: T;
  expiry: number;
}

/** Admin dashboard summary shape. */
export interface AdminSummary {
  totalProjects: number;
  activeProjects: number;
  totalMappings: number;
  negotiatingMappings: number;
  fullyAllocatedProjects: number;
  totalCenters: number;
  totalPrograms: number;
}

/** Program representative dashboard summary shape. */
export interface ProgramRepSummary {
  myMappings: number;
  negotiatingMappings: number;
  agreedMappings: number;
  lockedMappings: number;
  totalAllocated: number;
}

/** Center representative dashboard summary shape. */
export interface CenterRepSummary {
  projectsInCenter: number;
  negotiatingMappings: number;
  agreedMappings: number;
  lockedMappings: number;
}

/** Allocation status item for a single project. */
export interface AllocationStatusItem {
  id: number;
  code: string;
  name: string;
  allocatedPercent: number;
  status: string;
  mappingCount: number;
  negotiatingCount: number;
}

/** Recent activity event. */
export interface RecentActivityItem {
  type: 'initiated' | 'counter_proposed' | 'agreed' | 'reopened';
  projectName: string;
  programName: string;
  actorName: string;
  timestamp: Date;
}

/**
 * Service providing aggregated dashboard data.
 *
 * All queries use TypeORM QueryBuilder with COUNT/SUM aggregates to
 * avoid N+1 problems. Results are cached per-user for 2 minutes.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  /** Simple in-memory cache keyed by user ID + endpoint. */
  private cache = new Map<string, CacheEntry<any>>();

  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(ProjectMapping)
    private readonly mappingRepo: Repository<ProjectMapping>,
    @InjectRepository(MappingNegotiation)
    private readonly negotiationRepo: Repository<MappingNegotiation>,
    @InjectRepository(Center)
    private readonly centerRepo: Repository<Center>,
    @InjectRepository(Program)
    private readonly programRepo: Repository<Program>,
  ) {}

  // ──────────────────────────────────────────────────────────────────
  //  GET /dashboard/summary
  // ──────────────────────────────────────────────────────────────────

  /**
   * Return role-aware aggregate statistics for the dashboard summary.
   */
  async getSummary(
    user: User,
  ): Promise<AdminSummary | ProgramRepSummary | CenterRepSummary> {
    const cacheKey = `summary:${String(user.id)}`;

    return this.cached(cacheKey, async () => {
      switch (user.role) {
        case UserRole.ADMIN:
          return this.getAdminSummary();
        case UserRole.PROGRAM_REP:
          return this.getProgramRepSummary(user.programId);
        case UserRole.CENTER_REP:
          return this.getCenterRepSummary(user.centerId);
        default:
          return this.getAdminSummary();
      }
    });
  }

  private async getAdminSummary(): Promise<AdminSummary> {
    const [projectStats, mappingStats, fullyAllocated, totalCenters, totalPrograms] =
      await Promise.all([
        this.projectRepo
          .createQueryBuilder('p')
          .select('COUNT(*)', 'total')
          .addSelect(
            `SUM(CASE WHEN p.status = :active THEN 1 ELSE 0 END)`,
            'active',
          )
          .setParameter('active', ProjectStatus.ACTIVE)
          .getRawOne<{ total: string; active: string }>(),

        this.mappingRepo
          .createQueryBuilder('m')
          .select('COUNT(*)', 'total')
          .addSelect(
            `SUM(CASE WHEN m.status = :negotiating THEN 1 ELSE 0 END)`,
            'negotiating',
          )
          .setParameter('negotiating', MappingStatus.NEGOTIATING)
          .getRawOne<{ total: string; negotiating: string }>(),

        /* Projects where non-removed allocations sum to >= 100 */
        this.mappingRepo
          .createQueryBuilder('m')
          .select('m.project_id', 'projectId')
          .addSelect('SUM(m.allocation_percentage)', 'totalAlloc')
          .where('m.status != :removed', { removed: MappingStatus.REMOVED })
          .groupBy('m.project_id')
          .having('SUM(m.allocation_percentage) >= 100')
          .getRawMany<{ projectId: string; totalAlloc: string }>(),

        this.centerRepo.count(),
        this.programRepo.count(),
      ]);

    return {
      totalProjects: parseInt(projectStats?.total ?? '0', 10),
      activeProjects: parseInt(projectStats?.active ?? '0', 10),
      totalMappings: parseInt(mappingStats?.total ?? '0', 10),
      negotiatingMappings: parseInt(mappingStats?.negotiating ?? '0', 10),
      fullyAllocatedProjects: fullyAllocated.length,
      totalCenters,
      totalPrograms,
    };
  }

  private async getProgramRepSummary(
    programId: number | null,
  ): Promise<ProgramRepSummary> {
    if (!programId) {
      return {
        myMappings: 0,
        negotiatingMappings: 0,
        agreedMappings: 0,
        lockedMappings: 0,
        totalAllocated: 0,
      };
    }

    const result = await this.mappingRepo
      .createQueryBuilder('m')
      .select('COUNT(*)', 'total')
      .addSelect(
        `SUM(CASE WHEN m.status = :negotiating THEN 1 ELSE 0 END)`,
        'negotiating',
      )
      .addSelect(
        `SUM(CASE WHEN m.status = :agreed THEN 1 ELSE 0 END)`,
        'agreed',
      )
      .addSelect(
        `SUM(CASE WHEN m.status = :locked THEN 1 ELSE 0 END)`,
        'locked',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN m.status != :removed THEN m.allocation_percentage ELSE 0 END), 0)`,
        'totalAllocated',
      )
      .where('m.program_id = :programId', { programId })
      .andWhere('m.status NOT IN (:...hidden)', {
        hidden: [MappingStatus.DRAFT, MappingStatus.REMOVED],
      })
      .setParameter('negotiating', MappingStatus.NEGOTIATING)
      .setParameter('agreed', MappingStatus.AGREED)
      .setParameter('locked', MappingStatus.LOCKED)
      .setParameter('removed', MappingStatus.REMOVED)
      .getRawOne<{
        total: string;
        negotiating: string;
        agreed: string;
        locked: string;
        totalAllocated: string;
      }>();

    return {
      myMappings: parseInt(result?.total ?? '0', 10),
      negotiatingMappings: parseInt(result?.negotiating ?? '0', 10),
      agreedMappings: parseInt(result?.agreed ?? '0', 10),
      lockedMappings: parseInt(result?.locked ?? '0', 10),
      totalAllocated: parseFloat(result?.totalAllocated ?? '0'),
    };
  }

  private async getCenterRepSummary(
    centerId: number | null,
  ): Promise<CenterRepSummary> {
    if (!centerId) {
      return {
        projectsInCenter: 0,
        negotiatingMappings: 0,
        agreedMappings: 0,
        lockedMappings: 0,
      };
    }

    const [projectCount, mappingStats] = await Promise.all([
      this.projectRepo.count({ where: { centerId } }),

      this.mappingRepo
        .createQueryBuilder('m')
        .innerJoin('m.project', 'p')
        .select(
          `SUM(CASE WHEN m.status = :negotiating THEN 1 ELSE 0 END)`,
          'negotiating',
        )
        .addSelect(
          `SUM(CASE WHEN m.status = :agreed THEN 1 ELSE 0 END)`,
          'agreed',
        )
        .addSelect(
          `SUM(CASE WHEN m.status = :locked THEN 1 ELSE 0 END)`,
          'locked',
        )
        .where('p.center_id = :centerId', { centerId })
        .setParameter('negotiating', MappingStatus.NEGOTIATING)
        .setParameter('agreed', MappingStatus.AGREED)
        .setParameter('locked', MappingStatus.LOCKED)
        .getRawOne<{
          negotiating: string;
          agreed: string;
          locked: string;
        }>(),
    ]);

    return {
      projectsInCenter: projectCount,
      negotiatingMappings: parseInt(mappingStats?.negotiating ?? '0', 10),
      agreedMappings: parseInt(mappingStats?.agreed ?? '0', 10),
      lockedMappings: parseInt(mappingStats?.locked ?? '0', 10),
    };
  }

  // ──────────────────────────────────────────────────────────────────
  //  GET /dashboard/allocation-status
  // ──────────────────────────────────────────────────────────────────

  async getAllocationStatus(user: User): Promise<AllocationStatusItem[]> {
    const cacheKey = `allocation:${String(user.id)}`;

    return this.cached(cacheKey, async () => {
      const qb = this.projectRepo
        .createQueryBuilder('p')
        .leftJoin(
          (sub) =>
            sub
              .select('m.project_id', 'projectId')
              .addSelect('COALESCE(SUM(m.allocation_percentage), 0)', 'totalAlloc')
              .addSelect('COUNT(*)', 'mappingCount')
              .addSelect(
                `SUM(CASE WHEN m.status = '${MappingStatus.NEGOTIATING}' THEN 1 ELSE 0 END)`,
                'negotiatingCount',
              )
              .from(ProjectMapping, 'm')
              .where('m.status != :removed', { removed: MappingStatus.REMOVED })
              .groupBy('m.project_id'),
          'alloc',
          'alloc.projectId = p.id',
        )
        .select('p.id', 'id')
        .addSelect('p.code', 'code')
        .addSelect('p.name', 'name')
        .addSelect('COALESCE(alloc.totalAlloc, 0)', 'allocatedPercent')
        .addSelect('p.status', 'status')
        .addSelect('COALESCE(alloc.mappingCount, 0)', 'mappingCount')
        .addSelect('COALESCE(alloc.negotiatingCount, 0)', 'negotiatingCount');

      if (user.role === UserRole.CENTER_REP && user.centerId) {
        qb.where('p.center_id = :centerId', { centerId: user.centerId });
      }

      qb.orderBy('allocatedPercent', 'ASC').limit(50);

      const rows = await qb.getRawMany<{
        id: number | string;
        code: string;
        name: string;
        allocatedPercent: string;
        status: string;
        mappingCount: string;
        negotiatingCount: string;
      }>();

      return rows.map((r) => ({
        id: typeof r.id === 'number' ? r.id : parseInt(r.id, 10),
        code: r.code,
        name: r.name,
        allocatedPercent: parseFloat(r.allocatedPercent),
        status: r.status,
        mappingCount: parseInt(r.mappingCount, 10),
        negotiatingCount: parseInt(r.negotiatingCount, 10),
      }));
    });
  }

  // ──────────────────────────────────────────────────────────────────
  //  GET /dashboard/recent-activity
  // ──────────────────────────────────────────────────────────────────

  /**
   * Returns the last 20 negotiation events from the mapping_negotiations table.
   * Role-filtered: admin = all, program_rep = own program, center_rep = own center.
   */
  async getRecentActivity(user: User): Promise<RecentActivityItem[]> {
    const cacheKey = `activity:${String(user.id)}`;

    return this.cached(cacheKey, async () => {
      const qb = this.negotiationRepo
        .createQueryBuilder('n')
        .innerJoin('n.mapping', 'm')
        .innerJoin('m.project', 'p')
        .innerJoin('m.program', 'prog')
        .innerJoin('n.actor', 'actor')
        .select('n.event_type', 'eventType')
        .addSelect('p.name', 'projectName')
        .addSelect('prog.name', 'programName')
        .addSelect('actor.first_name', 'actorFirstName')
        .addSelect('actor.last_name', 'actorLastName')
        .addSelect('n.created_at', 'createdAt');

      /* Role-based filtering */
      if (user.role === UserRole.PROGRAM_REP && user.programId) {
        qb.where('m.program_id = :programId', { programId: user.programId });
      } else if (user.role === UserRole.CENTER_REP && user.centerId) {
        qb.where('p.center_id = :centerId', { centerId: user.centerId });
      }

      qb.orderBy('n.created_at', 'DESC').limit(20);

      const rows = await qb.getRawMany<{
        eventType: string;
        projectName: string;
        programName: string;
        actorFirstName: string;
        actorLastName: string;
        createdAt: Date;
      }>();

      return rows.map((r) => ({
        type: r.eventType as RecentActivityItem['type'],
        projectName: r.projectName,
        programName: r.programName,
        actorName: `${r.actorFirstName} ${r.actorLastName}`.trim(),
        timestamp: r.createdAt,
      }));
    });
  }

  // ──────────────────────────────────────────────────────────────────
  //  Cache helper
  // ──────────────────────────────────────────────────────────────────

  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const entry = this.cache.get(key);
    if (entry && entry.expiry > Date.now()) {
      return entry.data as T;
    }
    const data = await loader();
    this.cache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
    return data;
  }
}
