import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';

/** Summary data shape returned for admin role. */
export interface AdminSummary {
  totalProjects: number;
  activeProjects: number;
  totalMappings: number;
  negotiatingMappings: number;
  fullyAllocatedProjects: number;
  totalCenters: number;
  totalPrograms: number;
}

/**
 * Summary data shape returned for program_rep role.
 *
 * Project-level counts scoped to projects that mention the rep's program.
 * Mirrors CenterRepSummary so each card click navigates to the projects
 * list with the SAME row count.
 */
export interface ProgramRepSummary {
  myProjects: number;
  negotiatingProjects: number;
  readyToLockProjects: number;
  lockedProjects: number;
}

/**
 * Summary data shape returned for center_rep role.
 *
 * All four counters are project-level (distinct project IDs) over the
 * center's active, non-excluded portfolio. The three workflow-state
 * fields are mutually exclusive.
 */
export interface CenterRepSummary {
  projectsInCenter: number;
  /** Unlocked projects with at least one mapping in `negotiating` status. */
  negotiatingProjects: number;
  /** Unlocked projects whose every non-removed mapping is `agreed` (ready to lock). */
  readyToLockProjects: number;
  /** Projects with `negotiation_locked = 1`. */
  lockedProjects: number;
}

/** Union type for the dashboard summary — actual shape depends on the user's role. */
export type DashboardSummary = AdminSummary | ProgramRepSummary | CenterRepSummary;

/** Single allocation-status row returned by the API. */
export interface AllocationStatusItem {
  id: string;
  code: string;
  name: string;
  allocatedPercent: number;
  status: string;
  mappingCount: number;
  /** Count of mappings still in `draft` status — center hasn't opened them. */
  draftCount: number;
  negotiatingCount: number;
  agreedCount: number;
  /**
   * Count of non-removed mappings where the center side is the next
   * mover (program agreed but center hasn't, or removal request pending).
   */
  centerActionCount: number;
  /**
   * True when the project is unlocked, has mappings, every mapping is
   * agreed, and total allocation = 100. Center rep's only remaining
   * action is to lock the round.
   */
  readyToLock: boolean;
  projectLocked: boolean;
}

/** Per-program slice of a center's FY26 allocation. */
export interface CenterAllocationProgram {
  programId: number;
  name: string;
  officialCode: string;
  amount: number;
  percentOfBudget: number;
}

/** Center FY26 allocation widget payload. */
export interface CenterAllocationSummary {
  centerId: number;
  centerName: string;
  budgetYear: string;
  totalBudget: number;
  targetAmount: number;
  allocatedAmount: number;
  remainingAmount: number;
  allocatedPercent: number;
  remainingPercent: number;
  /** Budget in `negotiating` (not yet agreed) mappings, FY26-budget-weighted. */
  inNegotiationAmount: number;
  /** inNegotiationAmount as a % of the FY total budget. */
  inNegotiationPercent: number;
  programs: CenterAllocationProgram[];
}

/** Per-center slice of a program's FY26 agreed allocation. */
export interface ProgramAllocationCenter {
  centerId: number;
  name: string;
  acronym: string;
  amount: number;
  percentOfTotal: number;
}

/**
 * Program FY26 allocation widget payload (program-rep dashboard).
 * Pivots on center: which centers have mapped agreed budget to this program.
 */
export interface ProgramAllocationSummary {
  programId: number;
  programName: string;
  officialCode: string;
  budgetYear: string;
  totalAllocated: number;
  centers: ProgramAllocationCenter[];
}

/**
 * Per-center mapping-progress row (admin dashboard).
 * Goal = allocate 90 % of the center's FY26 budget to programs.
 */
export interface CenterProgressItem {
  centerId: number;
  centerName: string;
  acronym: string;
  totalBudget: number;
  allocatedBudget: number;
  allocatedPercent: number;
  targetPercent: number;
  metGoal: boolean;
  projectCount: number;
}

/**
 * Per-program mapping-progress row (admin dashboard).
 * Goal = zero open negotiations (no draft/negotiating mapping on an
 * unlocked project).
 */
export interface ProgramProgressItem {
  programId: number;
  programName: string;
  officialCode: string;
  totalMappings: number;
  resolvedMappings: number;
  openNegotiations: number;
  resolvedPercent: number;
  metGoal: boolean;
}

/** A single recent-activity entry returned by the API. */
export interface ActivityItem {
  type: 'initiated' | 'counter_proposed' | 'agreed' | 'reopened';
  projectName: string;
  programName: string;
  actorName: string;
  timestamp: string;
}

/**
 * DashboardService — fetches KPI summary, allocation status, and recent
 * activity data from the API for the role-aware dashboard view.
 */
@Injectable({ providedIn: 'root' })
export class DashboardService {
  private readonly api = inject(ApiService);

  /**
   * Returns role-scoped summary statistics.
   * The API selects the correct shape based on the authenticated user's role.
   */
  getSummary(): Observable<DashboardSummary> {
    return this.api.get<DashboardSummary>('/dashboard/summary');
  }

  /**
   * Returns the allocation status for all visible projects, sorted by
   * allocatedPercent ascending so the least-allocated appear first.
   */
  getAllocationStatus(): Observable<AllocationStatusItem[]> {
    return this.api.get<AllocationStatusItem[]>('/dashboard/allocation-status');
  }

  /**
   * Returns the most recent mapping activity events visible to the
   * authenticated user (role-scoped on the API side).
   */
  getRecentActivity(): Observable<ActivityItem[]> {
    return this.api.get<ActivityItem[]>('/dashboard/recent-activity');
  }

  /**
   * Returns the center FY26 allocation summary used by the center-rep
   * dashboard widget (90 % target, per-program agreed share, remainder).
   * Returns null when the caller has no center scope.
   */
  getCenterAllocation(): Observable<CenterAllocationSummary | null> {
    return this.api.get<CenterAllocationSummary | null>('/dashboard/center-allocation');
  }

  /**
   * Program-rep widget: the rep's program FY26 agreed allocation broken
   * down per contributing center. Returns null when the caller has no
   * program scope.
   */
  getProgramAllocation(): Observable<ProgramAllocationSummary | null> {
    return this.api.get<ProgramAllocationSummary | null>('/dashboard/program-allocation');
  }

  /**
   * Admin-only: per-center progress toward the 90 % budget-allocation goal.
   * Ordered worst-progress-first by the backend.
   */
  getCenterProgress(): Observable<CenterProgressItem[]> {
    return this.api.get<CenterProgressItem[]>('/dashboard/center-progress');
  }

  /**
   * Admin-only: per-program progress toward the zero-open-negotiations goal.
   * Ordered worst-progress-first by the backend.
   */
  getProgramProgress(): Observable<ProgramProgressItem[]> {
    return this.api.get<ProgramProgressItem[]>('/dashboard/program-progress');
  }
}
