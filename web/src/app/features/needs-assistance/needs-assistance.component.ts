import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule, DatePipe } from '@angular/common';
import { Subject, takeUntil } from 'rxjs';

// PrimeNG
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService } from 'primeng/api';

import { ProjectsService } from '../projects/services/projects.service';
import { ProjectWithAssistance } from '../projects/models/project.model';

/**
 * NeedsAssistanceComponent — admin / workflow_admin only page.
 *
 * Shows all projects that have at least one mapping flagged for
 * workflow-admin assistance (needsAssistanceMappingCount > 0).
 * Provides a direct link to each project's consolidated negotiation page
 * so a workflow admin can immediately take action.
 */
@Component({
  selector: 'app-needs-assistance',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    TableModule,
    ButtonModule,
    TagModule,
    SkeletonModule,
    ToastModule,
    TooltipModule,
  ],
  providers: [MessageService, DatePipe],
  templateUrl: './needs-assistance.component.html',
  styleUrl: './needs-assistance.component.scss',
})
export class NeedsAssistanceComponent implements OnInit, OnDestroy {
  private readonly projectsService = inject(ProjectsService);
  private readonly messageService = inject(MessageService);
  private readonly destroy$ = new Subject<void>();

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Flagged projects returned from the API. */
  readonly projects = signal<ProjectWithAssistance[]>([]);

  /** True while the initial fetch is in flight. */
  readonly loading = signal(true);

  /** Skeleton placeholder rows while loading. */
  readonly skeletonRows = Array(6).fill(null);

  // -------------------------------------------------------------------------
  // Computed
  // -------------------------------------------------------------------------

  /** Total number of flagged mappings across all projects in the list. */
  readonly totalFlaggedMappings = computed(() =>
    this.projects().reduce((sum, p) => sum + (p.needsAssistanceMappingCount ?? 0), 0),
  );

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  ngOnInit(): void {
    this.loadFlaggedProjects();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  loadFlaggedProjects(): void {
    this.loading.set(true);

    this.projectsService
      .getProjects({ needsAssistance: true, limit: 100 })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (response) => {
          // Cast is safe — backend includes needsAssistanceMappingCount on every row
          this.projects.set(response.data as ProjectWithAssistance[]);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'Failed to load flagged projects. Please try again.',
          });
        },
      });
  }

  // -------------------------------------------------------------------------
  // Display helpers
  // -------------------------------------------------------------------------

  /** PrimeNG Tag severity for a project status. */
  getStatusSeverity(status: string): 'success' | 'warn' | 'secondary' {
    const map: Record<string, 'success' | 'warn' | 'secondary'> = {
      active: 'success',
      draft: 'warn',
      archived: 'secondary',
    };
    return map[status] ?? 'secondary';
  }
}
