import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project } from '../projects/entities/project.entity';
import { ProjectBudget } from '../projects/entities/project-budget.entity';
import { ProjectExclusion } from '../projects/entities/project-exclusion.entity';
import { ProjectMapping } from '../mappings/entities/project-mapping.entity';
import { MappingNegotiation } from '../mappings/entities/mapping-negotiation.entity';
import { Center } from '../reference-data/entities/center.entity';
import { Program } from '../reference-data/entities/program.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/enums/user-role.enum';
import { ProjectStatus } from '../projects/enums/project-status.enum';
import { MappingStatus } from '../mappings/enums/mapping-status.enum';

/** Fiscal-year code used for the center allocation widget. */
const CENTER_ALLOCATION_BUDGET_YEAR = 'FY26';

/** The 90 % share of a center's FY budget that must be allocated to programs. */
const CENTER_ALLOCATION_TARGET_PERCENT = 90;

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

/**
 * Center representative dashboard summary shape.
 *
 * All four counts are **distinct project counts** scoped to the center's
 * visible (non-excluded, non-archived) portfolio. The three workflow-state
 * fields are mutually exclusive: a project is in exactly one of
 * negotiating / readyToLock / locked at any time, plus a fourth implicit
 * "no active mappings yet" bucket that does not get its own tile.
 */
export interface CenterRepSummary {
  /** Distinct active, non-excluded projects in the center. */
  projectsInCenter: number;
  /** Unlocked projects with at least one mapping in `negotiating` status. */
  negotiatingProjects: number;
  /** Unlocked projects whose every non-removed mapping is `agreed` (ready to lock). */
  readyToLockProjects: number;
  /** Projects with `negotiation_locked = 1`. */
  lockedProjects: number;
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

/** Per-program slice of a center's FY26 allocation. */
export interface CenterAllocationProgram {
  programId: number;
  name: string;
  officialCode: string;
  /** Allocated amount for the program in the center's FY budget currency. */
  amount: number;
  /** Allocated amount as a % of the center's FY total budget. */
  percentOfBudget: number;
}

/**
 * Center FY26 allocation summary for the center-rep dashboard widget.
 *
 * Captures the center's total FY26 budget, the 90 % allocation target,
 * the per-program agreed share, and the remaining gap to target.
 */
export interface CenterAllocationSummary {
  centerId: number;
  centerName: string;
  budgetYear: string;
  /** Full FY26 budget rolled up across the center's projects. */
  totalBudget: number;
  /** 90 % of `totalBudget` — the share that must be allocated to programs. */
  targetAmount: number;
  /** What's currently agreed-allocated to programs (Σ project_fy_budget × allocation %). */
  allocatedAmount: number;
  /** Remaining gap to the 90 % target (clamped at 0). */
  remainingAmount: number;
  /** Allocated amount as a % of the FY total budget. */
  allocatedPercent: number;
  /** Remaining gap to 90 % expressed as a % of the FY total budget. */
  remainingPercent: number;
  programs: CenterAllocationProgram[];
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
    @InjectRepository(ProjectBudget)
    private readonly projectBudgetRepo: Repository<ProjectBudget>,
    @InjectRepository(ProjectExclusion)
    private readonly exclusionRepo: Repository<ProjectExclusion>,
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
          throw new ForbiddenException(
            'You do not have permission to access the dashboard',
          );
      }
    });
  }

  private async getAdminSummary(): Promise<AdminSummary> {
    const [
      projectStats,
      mappingStats,
      fullyAllocated,
      totalCenters,
      totalPrograms,
    ] = await Promise.all([
      this.projectRepo
        .createQueryBuilder('p')
        .select('COUNT(*)', 'total')
        .addSelect(
          `SUM(CASE WHEN p.status = :active THEN 1 ELSE 0 END)`,
          'active',
        )
        .setParameter('active', ProjectStatus.ACTIVE)
        .getRawOne<{ total: string; active: string }>(),

      /* Total mappings counts every non-removed row (drafts are pre-workflow
       * but still real artifacts an admin may want to see). Negotiating
       * additionally requires the project to be unlocked — a stale
       * `negotiating` row on a locked project is a data anomaly, not a
       * live negotiation. Matches the predicate used in the program-rep
       * and center-rep summaries. */
      this.mappingRepo
        .createQueryBuilder('m')
        .innerJoin('m.project', 'p')
        .select(
          `SUM(CASE WHEN m.status != :removedTotal THEN 1 ELSE 0 END)`,
          'total',
        )
        .addSelect(
          `SUM(CASE WHEN m.status = :negotiating AND p.negotiation_locked = 0 THEN 1 ELSE 0 END)`,
          'negotiating',
        )
        .setParameter('negotiating', MappingStatus.NEGOTIATING)
        .setParameter('removedTotal', MappingStatus.REMOVED)
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
      .innerJoin('m.project', 'p')
      .select('COUNT(*)', 'total')
      .addSelect(
        `SUM(CASE WHEN m.status = :negotiating AND p.negotiation_locked = 0 THEN 1 ELSE 0 END)`,
        'negotiating',
      )
      .addSelect(
        `SUM(CASE WHEN m.status = :agreed AND p.negotiation_locked = 0 THEN 1 ELSE 0 END)`,
        'agreed',
      )
      .addSelect(
        `SUM(CASE WHEN p.negotiation_locked = 1 THEN 1 ELSE 0 END)`,
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
        negotiatingProjects: 0,
        readyToLockProjects: 0,
        lockedProjects: 0,
      };
    }

    /* Sub-select that identifies excluded project IDs for this center.
     * Reused in every per-project count below so the dashboard reflects
     * the same visible project set as the projects list. */
    const excludedSubSql = `
      SELECT pe_dash.project_id
      FROM project_exclusions pe_dash
      WHERE pe_dash.center_id = :dashCenterId
    `;

    /* All four counts work on the same scope: active, non-excluded projects
     * in this center. Counts are at the project level (DISTINCT project IDs)
     * so the tiles align with the "Projects in Center" total — a locked
     * project with N programs contributes 1 to `lockedProjects`, not N.
     * Workflow-state predicates are derived from this project's mapping set
     * via correlated EXISTS / NOT EXISTS sub-selects. */
    const result = await this.projectRepo
      .createQueryBuilder('p')
      .select('COUNT(*)', 'projectsInCenter')
      .addSelect(
        `SUM(
          CASE WHEN p.negotiation_locked = 0
            AND EXISTS (
              SELECT 1 FROM project_mappings pm_neg
              WHERE pm_neg.project_id = p.id
                AND pm_neg.status = :negotiating
            )
          THEN 1 ELSE 0 END
        )`,
        'negotiatingProjects',
      )
      .addSelect(
        /* Ready-to-lock = unlocked, has at least one mapping, every
         * non-removed mapping is agreed. Mirrors the lock guard in
         * MappingsService so the tile predicts what "Lock round" allows. */
        `SUM(
          CASE WHEN p.negotiation_locked = 0
            AND EXISTS (
              SELECT 1 FROM project_mappings pm_any
              WHERE pm_any.project_id = p.id
                AND pm_any.status != :removed
            )
            AND NOT EXISTS (
              SELECT 1 FROM project_mappings pm_pending
              WHERE pm_pending.project_id = p.id
                AND pm_pending.status NOT IN (:...agreedOrRemoved)
            )
          THEN 1 ELSE 0 END
        )`,
        'readyToLockProjects',
      )
      .addSelect(
        `SUM(CASE WHEN p.negotiation_locked = 1 THEN 1 ELSE 0 END)`,
        'lockedProjects',
      )
      .where('p.center_id = :centerId', { centerId })
      /* Drop archived from the center-rep dashboard — those projects are
       * not actionable here (the projects-list typeahead already excludes
       * them), and including them would inflate `projectsInCenter`
       * relative to the workflow-state tiles next to it. */
      .andWhere('p.status = :activeStatus', {
        activeStatus: ProjectStatus.ACTIVE,
      })
      .andWhere(`p.id NOT IN (${excludedSubSql})`, { dashCenterId: centerId })
      .setParameter('negotiating', MappingStatus.NEGOTIATING)
      .setParameter('removed', MappingStatus.REMOVED)
      .setParameter('agreedOrRemoved', [
        MappingStatus.AGREED,
        MappingStatus.REMOVED,
      ])
      .getRawOne<{
        projectsInCenter: string;
        negotiatingProjects: string;
        readyToLockProjects: string;
        lockedProjects: string;
      }>();

    return {
      projectsInCenter: parseInt(result?.projectsInCenter ?? '0', 10),
      negotiatingProjects: parseInt(result?.negotiatingProjects ?? '0', 10),
      readyToLockProjects: parseInt(result?.readyToLockProjects ?? '0', 10),
      lockedProjects: parseInt(result?.lockedProjects ?? '0', 10),
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
              .addSelect(
                'COALESCE(SUM(m.allocation_percentage), 0)',
                'totalAlloc',
              )
              .addSelect('COUNT(*)', 'mappingCount')
              .addSelect(
                `SUM(CASE WHEN m.status = '${MappingStatus.NEGOTIATING}' THEN 1 ELSE 0 END)`,
                'negotiatingCount',
              )
              .addSelect(
                `SUM(CASE WHEN m.status = '${MappingStatus.AGREED}' THEN 1 ELSE 0 END)`,
                'agreedCount',
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
        .addSelect('COALESCE(alloc.negotiatingCount, 0)', 'negotiatingCount')
        .addSelect('COALESCE(alloc.agreedCount, 0)', 'agreedCount')
        .addSelect('p.negotiation_locked', 'projectLocked')
        // Sort key: 0 when the project has any active mapping (i.e. it's
        // a real review candidate), 1 when it has none. Used in the
        // ORDER BY below to keep unmapped projects from filling the
        // limit-50 window ahead of projects that need attention.
        .addSelect(
          'CASE WHEN COALESCE(alloc.mappingCount, 0) > 0 THEN 0 ELSE 1 END',
          'hasMappingsRank',
        );

      if (user.role === UserRole.CENTER_REP && user.centerId) {
        qb.where('p.center_id = :centerId', { centerId: user.centerId });

        /* Center-rep allocation status hides excluded projects so the widget
         * reflects only the visible portfolio. */
        qb.andWhere(
          `p.id NOT IN (
            SELECT pe_alloc.project_id
            FROM project_exclusions pe_alloc
            WHERE pe_alloc.center_id = :allocCenterId
          )`,
          { allocCenterId: user.centerId },
        );
      }

      // Surface projects needing attention first within the 50-row window:
      //   1. Unlocked before locked.
      //   2. Projects with at least one active mapping before bare
      //      0%-projects — otherwise centers with many unmapped projects
      //      fill the limit and push real review candidates off the list.
      //   3. Then by allocation % ascending so the least-allocated
      //      among reviewable projects bubbles up.
      qb.orderBy('projectLocked', 'ASC')
        .addOrderBy('hasMappingsRank', 'ASC')
        .addOrderBy('allocatedPercent', 'ASC')
        .limit(50);

      const rows = await qb.getRawMany<{
        id: number | string;
        code: string;
        name: string;
        allocatedPercent: string;
        status: string;
        mappingCount: string;
        negotiatingCount: string;
        agreedCount: string;
        projectLocked: number | string | boolean;
      }>();

      return rows.map((r) => ({
        id: typeof r.id === 'number' ? r.id : parseInt(r.id, 10),
        code: r.code,
        name: r.name,
        allocatedPercent: parseFloat(r.allocatedPercent),
        status: r.status,
        mappingCount: parseInt(r.mappingCount, 10),
        negotiatingCount: parseInt(r.negotiatingCount, 10),
        agreedCount: parseInt(r.agreedCount, 10),
        projectLocked: Boolean(Number(r.projectLocked)),
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

        /* Suppress activity from excluded projects so the feed only shows
         * events for the center rep's visible portfolio. */
        qb.andWhere(
          `p.id NOT IN (
            SELECT pe_act.project_id
            FROM project_exclusions pe_act
            WHERE pe_act.center_id = :actCenterId
          )`,
          { actCenterId: user.centerId },
        );
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
  //  GET /dashboard/center-allocation
  // ──────────────────────────────────────────────────────────────────

  /**
   * Returns the center-rep allocation widget data: total FY26 budget,
   * 90 % target, per-program agreed share, and the remaining gap.
   *
   * Resolves the center from `user.centerId` for center reps; admins
   * may pass any center via `centerIdOverride`.
   *
   * Per-program share is computed as
   *   Σ (project_fy26_budget × agreed_mapping.allocation_percentage / 100)
   * across the center's projects, then expressed as a % of the FY total.
   */
  async getCenterAllocation(
    user: User,
    centerIdOverride?: number,
  ): Promise<CenterAllocationSummary | null> {
    const centerId =
      user.role === UserRole.ADMIN && centerIdOverride
        ? centerIdOverride
        : user.centerId;

    if (!centerId) {
      return null;
    }

    const cacheKey = `centerAllocation:${centerId}`;

    return this.cached(cacheKey, async () => {
      const center = await this.centerRepo.findOne({ where: { id: centerId } });
      if (!center) {
        return null;
      }

      /* Reusable exclusion sub-select for this center. Applied to both the
       * budget total and the per-program allocation so the allocation widget
       * reflects only the center's visible (non-excluded) projects. */
      const caExcludedSubSql = `
        SELECT pe_ca.project_id
        FROM project_exclusions pe_ca
        WHERE pe_ca.center_id = :caExcludingCenterId
      `;

      /* Total FY26 budget across the center's non-excluded projects. */
      const budgetRow = await this.projectBudgetRepo
        .createQueryBuilder('pb')
        .innerJoin('pb.project', 'p')
        .select('COALESCE(SUM(pb.amount), 0)', 'total')
        .where('p.center_id = :centerId', { centerId })
        .andWhere(`p.id NOT IN (${caExcludedSubSql})`, {
          caExcludingCenterId: centerId,
        })
        .andWhere('pb.year = :year', { year: CENTER_ALLOCATION_BUDGET_YEAR })
        .getRawOne<{ total: string }>();

      const totalBudget = parseFloat(budgetRow?.total ?? '0');
      const targetAmount =
        (totalBudget * CENTER_ALLOCATION_TARGET_PERCENT) / 100;

      /* Per-program agreed allocation, weighted by each project's FY26 budget. */
      const programRows = await this.mappingRepo
        .createQueryBuilder('m')
        .innerJoin('m.project', 'p')
        .innerJoin('m.program', 'prog')
        .innerJoin(
          (sub) =>
            sub
              .select('pb.project_id', 'projectId')
              .addSelect('COALESCE(SUM(pb.amount), 0)', 'fyBudget')
              .from(ProjectBudget, 'pb')
              .where('pb.year = :year', { year: CENTER_ALLOCATION_BUDGET_YEAR })
              .groupBy('pb.project_id'),
          'pby',
          'pby.projectId = p.id',
        )
        .select('prog.id', 'programId')
        .addSelect('prog.name', 'name')
        .addSelect('prog.official_code', 'officialCode')
        .addSelect(
          'COALESCE(SUM(pby.fyBudget * m.allocation_percentage / 100), 0)',
          'amount',
        )
        .where('p.center_id = :centerId', { centerId })
        .andWhere(`p.id NOT IN (${caExcludedSubSql})`, {
          caExcludingCenterId: centerId,
        })
        .andWhere('m.status = :agreed', { agreed: MappingStatus.AGREED })
        .groupBy('prog.id')
        .addGroupBy('prog.name')
        .addGroupBy('prog.official_code')
        .orderBy('amount', 'DESC')
        .getRawMany<{
          programId: string;
          name: string;
          officialCode: string;
          amount: string;
        }>();

      const programs: CenterAllocationProgram[] = programRows.map((r) => {
        const amount = parseFloat(r.amount);
        return {
          programId: parseInt(r.programId, 10),
          name: r.name,
          officialCode: r.officialCode,
          amount,
          percentOfBudget: totalBudget > 0 ? (amount / totalBudget) * 100 : 0,
        };
      });

      const allocatedAmount = programs.reduce((sum, p) => sum + p.amount, 0);
      const remainingAmount = Math.max(0, targetAmount - allocatedAmount);
      const allocatedPercent =
        totalBudget > 0 ? (allocatedAmount / totalBudget) * 100 : 0;
      const remainingPercent =
        totalBudget > 0 ? (remainingAmount / totalBudget) * 100 : 0;

      return {
        centerId: center.id,
        centerName: center.name,
        budgetYear: CENTER_ALLOCATION_BUDGET_YEAR,
        totalBudget,
        targetAmount,
        allocatedAmount,
        remainingAmount,
        allocatedPercent,
        remainingPercent,
        programs,
      };
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
