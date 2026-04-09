import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule, DecimalPipe } from '@angular/common';

// PrimeNG imports
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { ProgressBarModule } from 'primeng/progressbar';
import { SkeletonModule } from 'primeng/skeleton';
import { TagModule } from 'primeng/tag';
import { ChartModule } from 'primeng/chart';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { AuthService } from '../../core/services/auth.service';
import {
  DashboardService,
  AdminSummary,
  ProgramRepSummary,
  CenterRepSummary,
  AllocationStatusItem,
  ActivityItem,
} from './services/dashboard.service';

/** Type guard — narrows summary to AdminSummary. */
function isAdminSummary(s: object): s is AdminSummary {
  return 'totalProjects' in s;
}

/** Type guard — narrows summary to ProgramRepSummary. */
function isProgramRepSummary(s: object): s is ProgramRepSummary {
  return 'myMappings' in s;
}

/** Type guard — narrows summary to CenterRepSummary. */
function isCenterRepSummary(s: object): s is CenterRepSummary {
  return 'projectsInCenter' in s;
}

/**
 * DashboardComponent — role-aware landing page.
 *
 * Renders three distinct views depending on the authenticated user's role:
 *  - admin       — platform-wide KPIs, allocation status table, bar chart, recent activity
 *  - program_rep — own mapping stats, doughnut chart, quick action, recent activity
 *  - center_rep  — center-scoped project stats, pending review table, recent activity
 *
 * All three views share common loading-skeleton and refresh-button patterns.
 */
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    DecimalPipe,
    CardModule,
    ButtonModule,
    TableModule,
    ProgressBarModule,
    SkeletonModule,
    TagModule,
    ChartModule,
    ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent implements OnInit {
  private readonly dashboardService = inject(DashboardService);
  private readonly authService = inject(AuthService);
  private readonly messageService = inject(MessageService);

  // -------------------------------------------------------------------------
  // Reactive state
  // -------------------------------------------------------------------------

  /** Current user role shortcut — drives template branching. */
  readonly userRole = computed(() => this.authService.currentUser()?.role ?? null);

  /** True while any fetch is in progress. */
  readonly loading = signal(true);

  /** Raw summary object — shape depends on role. */
  readonly summary = signal<object | null>(null);

  /** Allocation status list (admin + center_rep). */
  readonly allocationItems = signal<AllocationStatusItem[]>([]);

  /** Recent activity entries. */
  readonly recentActivity = signal<ActivityItem[]>([]);

  // -------------------------------------------------------------------------
  // Computed typed views of summary
  // -------------------------------------------------------------------------

  readonly adminSummary = computed(() => {
    const s = this.summary();
    return s && isAdminSummary(s) ? s : null;
  });

  readonly programRepSummary = computed(() => {
    const s = this.summary();
    return s && isProgramRepSummary(s) ? s : null;
  });

  readonly centerRepSummary = computed(() => {
    const s = this.summary();
    return s && isCenterRepSummary(s) ? s : null;
  });

  // -------------------------------------------------------------------------
  // Chart data (computed from allocation items)
  // -------------------------------------------------------------------------

  /**
   * Bar-chart data: bucket projects by allocated percentage band.
   * Used by the admin view.
   */
  readonly barChartData = computed(() => {
    const items = this.allocationItems();
    const bands = [0, 0, 0, 0, 0]; // 0-25, 25-50, 50-75, 75-99, 100
    for (const item of items) {
      const pct = item.allocatedPercent;
      if (pct <= 25) bands[0]++;
      else if (pct <= 50) bands[1]++;
      else if (pct <= 75) bands[2]++;
      else if (pct < 100) bands[3]++;
      else bands[4]++;
    }
    return {
      labels: ['0–25%', '25–50%', '50–75%', '75–99%', '100%'],
      datasets: [
        {
          label: 'Projects',
          data: bands,
          backgroundColor: [
            '#f87171', // red — least allocated
            '#fb923c',
            '#facc15',
            '#4ade80',
            '#22c55e', // green — fully allocated
          ],
          borderRadius: 4,
        },
      ],
    };
  });

  /** Bar-chart display options. */
  readonly barChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      y: {
        beginAtZero: true,
        ticks: { precision: 0 },
        grid: { color: '#f0f0f0' },
      },
      x: { grid: { display: false } },
    },
  };

  /**
   * Doughnut-chart data for program_rep: mapping status breakdown.
   */
  readonly doughnutChartData = computed(() => {
    const s = this.programRepSummary();
    if (!s) return null;
    return {
      labels: ['Pending', 'Approved', 'Rejected'],
      datasets: [
        {
          data: [s.pendingMappings, s.approvedMappings, s.rejectedMappings],
          backgroundColor: ['#facc15', '#22c55e', '#f87171'],
          hoverOffset: 4,
        },
      ],
    };
  });

  /** Doughnut chart display options. */
  readonly doughnutChartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom' as const,
        labels: { padding: 16, boxWidth: 12 },
      },
    },
    cutout: '65%',
  };

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  ngOnInit(): void {
    this.loadAll();
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  /** Loads all dashboard data in parallel and tracks the loading state. */
  loadAll(): void {
    this.loading.set(true);
    const role = this.userRole();

    // Always fetch summary and activity; allocation status is only needed by
    // admin and center_rep views.
    const fetches: Promise<void>[] = [
      this.fetchSummary(),
      this.fetchRecentActivity(),
    ];

    if (role === 'admin' || role === 'center_rep') {
      fetches.push(this.fetchAllocationStatus());
    }

    Promise.all(fetches).finally(() => this.loading.set(false));
  }

  private async fetchSummary(): Promise<void> {
    try {
      const data = await new Promise<object>((resolve, reject) =>
        this.dashboardService.getSummary().subscribe({ next: resolve, error: reject }),
      );
      this.summary.set(data);
    } catch {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: 'Failed to load dashboard summary.',
      });
    }
  }

  private async fetchAllocationStatus(): Promise<void> {
    try {
      const data = await new Promise<AllocationStatusItem[]>((resolve, reject) =>
        this.dashboardService.getAllocationStatus().subscribe({ next: resolve, error: reject }),
      );
      this.allocationItems.set(data);
    } catch {
      // Non-critical — table will render as empty.
    }
  }

  private async fetchRecentActivity(): Promise<void> {
    try {
      const data = await new Promise<ActivityItem[]>((resolve, reject) =>
        this.dashboardService.getRecentActivity().subscribe({ next: resolve, error: reject }),
      );
      this.recentActivity.set(data);
    } catch {
      // Non-critical — activity list will render as empty.
    }
  }

  // -------------------------------------------------------------------------
  // Template helpers
  // -------------------------------------------------------------------------

  /** Returns a PrimeIcons class for a given activity type. */
  activityIcon(type: ActivityItem['type']): string {
    const map: Record<string, string> = {
      created: 'pi pi-plus-circle',
      approved: 'pi pi-check-circle',
      rejected: 'pi pi-times-circle',
      updated: 'pi pi-pencil',
    };
    return map[type] ?? 'pi pi-info-circle';
  }

  /** Returns a CSS class suffix for the activity icon color. */
  activityIconClass(type: ActivityItem['type']): string {
    const map: Record<string, string> = {
      created: 'activity-created',
      approved: 'activity-approved',
      rejected: 'activity-rejected',
      updated: 'activity-updated',
    };
    return map[type] ?? '';
  }

  /** Formats an ISO timestamp as a relative label ("2 hours ago"). */
  relativeTime(isoString: string): string {
    const now = Date.now();
    const then = new Date(isoString).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
  }

  /** Progress bar color based on allocation percentage. */
  progressBarSeverity(pct: number): 'success' | 'info' | 'warn' | 'danger' {
    if (pct >= 100) return 'success';
    if (pct >= 75) return 'info';
    if (pct >= 50) return 'warn';
    return 'danger';
  }

  /** Skeleton row array for table loading state. */
  readonly skeletonRows = Array(5).fill(null);
}
