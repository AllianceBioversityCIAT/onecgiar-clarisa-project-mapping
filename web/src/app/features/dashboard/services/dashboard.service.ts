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

/** Summary data shape returned for program_rep role. */
export interface ProgramRepSummary {
  myMappings: number;
  negotiatingMappings: number;
  agreedMappings: number;
  lockedMappings: number;
  totalAllocated: number;
}

/** Summary data shape returned for center_rep role. */
export interface CenterRepSummary {
  projectsInCenter: number;
  negotiatingMappings: number;
  agreedMappings: number;
  lockedMappings: number;
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
  negotiatingCount: number;
  agreedCount: number;
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
  programs: CenterAllocationProgram[];
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
    return this.api.get<CenterAllocationSummary | null>(
      '/dashboard/center-allocation',
    );
  }
}
