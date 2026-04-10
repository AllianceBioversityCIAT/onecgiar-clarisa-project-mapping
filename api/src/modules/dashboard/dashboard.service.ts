import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project } from '../projects/entities/project.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
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
  pendingApprovals: number;
  fullyAllocatedProjects: number;
  totalCenters: number;
  totalPrograms: number;
}

/** Program representative dashboard summary shape. */
export interface ProgramRepSummary {
  myMappings: number;
  pendingMappings: number;
  approvedMappings: number;
  rejectedMappings: number;
  totalAllocated: number;
}

/** Center representative dashboard summary shape. */
export interface CenterRepSummary {
  projectsInCenter: number;
  pendingReviews: number;
  approvedMappings: number;
  rejectedMappings: number;
}

/** Allocation status item for a single project. */
export interface AllocationStatusItem {
  id: string;
  code: string;
  name: string;
  allocatedPercent: number;
  status: string;
  mappingCount: number;
  pendingCount: number;
}

/** Recent activity event. */
export interface RecentActivityItem {
  type: 'mapping_created' | 'mapping_approved' | 'mapping_rejected';
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
   *
   * Admin sees system-wide totals; program_rep sees their own mappings;
   * center_rep sees their center's projects and mappings.
   */
  async getSummary(
    user: User,
  ): Promise<AdminSummary | ProgramRepSummary | CenterRepSummary> {
    const cacheKey = `summary:${user.id}`;

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

  /**
   * Build admin-level summary with system-wide aggregate counts.
   */
  private async getAdminSummary(): Promise<AdminSummary> {
    const [projectStats, mappingStats, fullyAllocated, totalCenters, totalPrograms] =
      await Promise.all([
        /* Total and active project counts in a single query */
        this.projectRepo
          .createQueryBuilder('p')
          .select('COUNT(*)', 'total')
          .addSelect(
            `SUM(CASE WHEN p.status = :active THEN 1 ELSE 0 END)`,
            'active',
          )
          .setParameter('active', ProjectStatus.ACTIVE)
          .getRawOne<{ total: string; active: string }>(),

        /* Total mappings and pending approvals in a single query */
        this.mappingRepo
          .createQueryBuilder('m')
          .select('COUNT(*)', 'total')
          .addSelect(
            `SUM(CASE WHEN m.status = :pending THEN 1 ELSE 0 END)`,
            'pending',
          )
          .setParameter('pending', MappingStatus.PENDING)
          .getRawOne<{ total: string; pending: string }>(),

        /* Projects where non-rejected allocations sum to >= 100 */
        this.mappingRepo
          .createQueryBuilder('m')
          .select('m.project_id', 'projectId')
          .addSelect('SUM(m.allocation_percentage)', 'totalAlloc')
          .where('m.status != :rejected', { rejected: MappingStatus.REJECTED })
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
      pendingApprovals: parseInt(mappingStats?.pending ?? '0', 10),
      fullyAllocatedProjects: fullyAllocated.length,
      totalCenters,
      totalPrograms,
    };
  }

  /**
   * Build program representative summary filtered by their programId.
   */
  private async getProgramRepSummary(
    programId: string | null,
  ): Promise<ProgramRepSummary> {
    if (!programId) {
      return {
        myMappings: 0,
        pendingMappings: 0,
        approvedMappings: 0,
        rejectedMappings: 0,
        totalAllocated: 0,
      };
    }

    const result = await this.mappingRepo
      .createQueryBuilder('m')
      .select('COUNT(*)', 'total')
      .addSelect(
        `SUM(CASE WHEN m.status = :pending THEN 1 ELSE 0 END)`,
        'pending',
      )
      .addSelect(
        `SUM(CASE WHEN m.status = :approved THEN 1 ELSE 0 END)`,
        'approved',
      )
      .addSelect(
        `SUM(CASE WHEN m.status = :rejected THEN 1 ELSE 0 END)`,
        'rejected',
      )
      .addSelect(
        `COALESCE(SUM(CASE WHEN m.status != :rejected THEN m.allocation_percentage ELSE 0 END), 0)`,
        'totalAllocated',
      )
      .where('m.program_id = :programId', { programId })
      .setParameter('pending', MappingStatus.PENDING)
      .setParameter('approved', MappingStatus.APPROVED)
      .setParameter('rejected', MappingStatus.REJECTED)
      .getRawOne<{
        total: string;
        pending: string;
        approved: string;
        rejected: string;
        totalAllocated: string;
      }>();

    return {
      myMappings: parseInt(result?.total ?? '0', 10),
      pendingMappings: parseInt(result?.pending ?? '0', 10),
      approvedMappings: parseInt(result?.approved ?? '0', 10),
      rejectedMappings: parseInt(result?.rejected ?? '0', 10),
      totalAllocated: parseFloat(result?.totalAllocated ?? '0'),
    };
  }

  /**
   * Build center representative summary filtered by their centerId.
   */
  private async getCenterRepSummary(
    centerId: string | null,
  ): Promise<CenterRepSummary> {
    if (!centerId) {
      return {
        projectsInCenter: 0,
        pendingReviews: 0,
        approvedMappings: 0,
        rejectedMappings: 0,
      };
    }

    const [projectCount, mappingStats] = await Promise.all([
      this.projectRepo.count({ where: { centerId } }),

      this.mappingRepo
        .createQueryBuilder('m')
        .innerJoin('m.project', 'p')
        .select(
          `SUM(CASE WHEN m.status = :pending THEN 1 ELSE 0 END)`,
          'pending',
        )
        .addSelect(
          `SUM(CASE WHEN m.status = :approved THEN 1 ELSE 0 END)`,
          'approved',
        )
        .addSelect(
          `SUM(CASE WHEN m.status = :rejected THEN 1 ELSE 0 END)`,
          'rejected',
        )
        .where('p.center_id = :centerId', { centerId })
        .setParameter('pending', MappingStatus.PENDING)
        .setParameter('approved', MappingStatus.APPROVED)
        .setParameter('rejected', MappingStatus.REJECTED)
        .getRawOne<{ pending: string; approved: string; rejected: string }>(),
    ]);

    return {
      projectsInCenter: projectCount,
      pendingReviews: parseInt(mappingStats?.pending ?? '0', 10),
      approvedMappings: parseInt(mappingStats?.approved ?? '0', 10),
      rejectedMappings: parseInt(mappingStats?.rejected ?? '0', 10),
    };
  }

  // ──────────────────────────────────────────────────────────────────
  //  GET /dashboard/allocation-status
  // ──────────────────────────────────────────────────────────────────

  /**
   * Return projects with their allocation progress, sorted by least
   * allocated first so incomplete projects surface at the top.
   *
   * Admin sees all projects; center_rep sees only their center's projects.
   * Limited to 50 results.
   */
  async getAllocationStatus(user: User): Promise<AllocationStatusItem[]> {
    const cacheKey = `allocation:${user.id}`;

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
                `SUM(CASE WHEN m.status = '${MappingStatus.PENDING}' THEN 1 ELSE 0 END)`,
                'pendingCount',
              )
              .from(ProjectMapping, 'm')
              .where('m.status != :rejected', { rejected: MappingStatus.REJECTED })
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
        .addSelect('COALESCE(alloc.pendingCount, 0)', 'pendingCount');

      /* Center reps only see their own center's projects */
      if (user.role === UserRole.CENTER_REP && user.centerId) {
        qb.where('p.center_id = :centerId', { centerId: user.centerId });
      }

      qb.orderBy('allocatedPercent', 'ASC').limit(50);

      const rows = await qb.getRawMany<{
        id: string;
        code: string;
        name: string;
        allocatedPercent: string;
        status: string;
        mappingCount: string;
        pendingCount: string;
      }>();

      return rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        allocatedPercent: parseFloat(r.allocatedPercent),
        status: r.status,
        mappingCount: parseInt(r.mappingCount, 10),
        pendingCount: parseInt(r.pendingCount, 10),
      }));
    });
  }

  // ──────────────────────────────────────────────────────────────────
  //  GET /dashboard/recent-activity
  // ──────────────────────────────────────────────────────────────────

  /**
   * Return the last 20 mapping events (creation, approval, rejection).
   *
   * Determines event type from mapping status and uses submittedAt for
   * creation events or reviewedAt for approval/rejection events.
   * Role-filtered: admin = all, program_rep = own program,
   * center_rep = own center's projects.
   */
  async getRecentActivity(user: User): Promise<RecentActivityItem[]> {
    const cacheKey = `activity:${user.id}`;

    return this.cached(cacheKey, async () => {
      const qb = this.mappingRepo
        .createQueryBuilder('m')
        .innerJoin('m.project', 'p')
        .innerJoin('m.program', 'prog')
        .innerJoin('m.submittedBy', 'submitter')
        .leftJoin('m.reviewedBy', 'reviewer')
        .select('m.status', 'status')
        .addSelect('p.name', 'projectName')
        .addSelect('prog.name', 'programName')
        .addSelect('submitter.first_name', 'submitterFirstName')
        .addSelect('submitter.last_name', 'submitterLastName')
        .addSelect('reviewer.first_name', 'reviewerFirstName')
        .addSelect('reviewer.last_name', 'reviewerLastName')
        .addSelect('m.submitted_at', 'submittedAt')
        .addSelect('m.reviewed_at', 'reviewedAt');

      /* Role-based filtering */
      if (user.role === UserRole.PROGRAM_REP && user.programId) {
        qb.where('m.program_id = :programId', { programId: user.programId });
      } else if (user.role === UserRole.CENTER_REP && user.centerId) {
        qb.where('p.center_id = :centerId', { centerId: user.centerId });
      }

      /* Order by most recent event timestamp first */
      qb.orderBy(
        'GREATEST(m.submitted_at, COALESCE(m.reviewed_at, m.submitted_at))',
        'DESC',
      ).limit(20);

      const rows = await qb.getRawMany<{
        status: string;
        projectName: string;
        programName: string;
        submitterFirstName: string;
        submitterLastName: string;
        reviewerFirstName: string | null;
        reviewerLastName: string | null;
        submittedAt: Date;
        reviewedAt: Date | null;
      }>();

      return rows.map((r) => {
        let type: RecentActivityItem['type'];
        let actorName: string;
        let timestamp: Date;

        if (r.status === MappingStatus.APPROVED && r.reviewedAt) {
          type = 'mapping_approved';
          actorName = `${r.reviewerFirstName ?? ''} ${r.reviewerLastName ?? ''}`.trim();
          timestamp = r.reviewedAt;
        } else if (r.status === MappingStatus.REJECTED && r.reviewedAt) {
          type = 'mapping_rejected';
          actorName = `${r.reviewerFirstName ?? ''} ${r.reviewerLastName ?? ''}`.trim();
          timestamp = r.reviewedAt;
        } else {
          type = 'mapping_created';
          actorName = `${r.submitterFirstName} ${r.submitterLastName}`.trim();
          timestamp = r.submittedAt;
        }

        return {
          type,
          projectName: r.projectName,
          programName: r.programName,
          actorName,
          timestamp,
        };
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────
  //  Cache helper
  // ──────────────────────────────────────────────────────────────────

  /**
   * Generic in-memory cache with a 2-minute TTL.
   * If the cache entry exists and has not expired, return it directly.
   * Otherwise execute the loader, store the result, and return it.
   */
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
