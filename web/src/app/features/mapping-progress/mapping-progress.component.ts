import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { SkeletonModule } from 'primeng/skeleton';
import { TooltipModule } from 'primeng/tooltip';
import { firstValueFrom } from 'rxjs';
import {
  DashboardService,
  CenterProgressItem,
  ProgramProgressItem,
} from '../dashboard/services/dashboard.service';

/**
 * Mapping Progress — portfolio-wide view of negotiation progress.
 *
 * Two sections (moved out of the admin dashboard so program reps, center
 * reps and admins can all see them):
 *  - Center Progress: each center's projects split into locked / mapped
 *    (in negotiation) / unmapped, with FY26 budget per state in the tooltip.
 *  - Program Progress: each program's mappings split into resolved / open,
 *    with FY26 program-allocated budget per state in the tooltip.
 *
 * Data is global (not user-scoped) — it's a shared portfolio overview.
 */
@Component({
  selector: 'app-mapping-progress',
  standalone: true,
  imports: [CommonModule, TableModule, SkeletonModule, TooltipModule],
  templateUrl: './mapping-progress.component.html',
  styleUrl: './mapping-progress.component.scss',
})
export class MappingProgressComponent implements OnInit {
  private readonly dashboardService = inject(DashboardService);

  readonly loading = signal(true);
  readonly centerProgress = signal<CenterProgressItem[] | null>(null);
  readonly programProgress = signal<ProgramProgressItem[] | null>(null);

  /** Placeholder rows so the tables render skeletons while loading. */
  readonly skeletonRows = Array(6).fill(null);

  ngOnInit(): void {
    this.loading.set(true);
    Promise.all([this.fetchCenterProgress(), this.fetchProgramProgress()]).finally(() =>
      this.loading.set(false),
    );
  }

  private async fetchCenterProgress(): Promise<void> {
    try {
      this.centerProgress.set(await firstValueFrom(this.dashboardService.getCenterProgress()));
    } catch {
      // Non-critical — table shows its empty state when null.
    }
  }

  private async fetchProgramProgress(): Promise<void> {
    try {
      this.programProgress.set(await firstValueFrom(this.dashboardService.getProgramProgress()));
    } catch {
      // Non-critical — table shows its empty state when null.
    }
  }

  // ---------------------------------------------------------------------------
  // Center Progress helpers
  // ---------------------------------------------------------------------------

  /**
   * Unmapped projects for a Center Progress row: the remainder of the
   * center's projects that are neither locked nor mapped (in negotiation).
   * Derived so the 3-segment status bar sums exactly to `projectCount`.
   */
  unmappedProjects(row: CenterProgressItem): number {
    return Math.max(0, row.projectCount - row.lockedProjects - row.mappedProjects);
  }

  /** FY26 budget of the row's unmapped projects (total − locked − mapped). */
  unmappedBudget(row: CenterProgressItem): number {
    return Math.max(0, row.totalBudget - row.lockedBudget - row.mappedBudget);
  }

  /**
   * Rich (HTML) tooltip for the Center Progress status bar: one row per
   * segment with a color swatch matching the bar, the project count, and
   * the FY26 budget. Rendered via pTooltip `[escape]="false"`.
   */
  statusTooltip(row: CenterProgressItem): string {
    const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
    const projects = (n: number) => `${n} ${n === 1 ? 'project' : 'projects'}`;
    const line = (color: string, label: string, count: number, budget: number) =>
      `<div class="tt-row">` +
      `<span class="tt-sw" style="background:${color}"></span>` +
      `<span class="tt-label">${label}</span>` +
      `<span class="tt-count">${projects(count)}</span>` +
      `<span class="tt-val">${money(budget)}</span>` +
      `</div>`;
    return (
      `<div class="tt-title">Projects by status</div>` +
      line('#22c55e', 'Locked', row.lockedProjects, row.lockedBudget) +
      line('#5569dd', 'Mapped', row.mappedProjects, row.mappedBudget) +
      line('#cbd1da', 'Unmapped', this.unmappedProjects(row), this.unmappedBudget(row))
    );
  }

  // ---------------------------------------------------------------------------
  // Program Progress helpers
  // ---------------------------------------------------------------------------

  /**
   * Rich (HTML) tooltip for the Program Progress status bar: one row per
   * mapping state (resolved / open) with a color swatch, mapping count, and
   * FY26 program-allocated budget. Rendered via pTooltip `[escape]="false"`.
   */
  programTooltip(row: ProgramProgressItem): string {
    const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
    const mappings = (n: number) => `${n} ${n === 1 ? 'mapping' : 'mappings'}`;
    const line = (color: string, label: string, count: number, budget: number) =>
      `<div class="tt-row">` +
      `<span class="tt-sw" style="background:${color}"></span>` +
      `<span class="tt-label">${label}</span>` +
      `<span class="tt-count">${mappings(count)}</span>` +
      `<span class="tt-val">${money(budget)}</span>` +
      `</div>`;
    return (
      `<div class="tt-title">Mappings by status</div>` +
      line('#22c55e', 'Resolved', row.resolvedMappings, row.resolvedBudget) +
      line('#5569dd', 'Open', row.openNegotiations, row.openBudget)
    );
  }
}
