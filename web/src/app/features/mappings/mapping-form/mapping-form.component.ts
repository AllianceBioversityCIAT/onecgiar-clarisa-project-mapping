import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import {
  ReactiveFormsModule,
  FormBuilder,
  FormGroup,
  Validators,
} from '@angular/forms';
import { firstValueFrom } from 'rxjs';

// PrimeNG imports
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ToastModule } from 'primeng/toast';
import { DividerModule } from 'primeng/divider';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { SkeletonModule } from 'primeng/skeleton';
import { MessageService } from 'primeng/api';

import { MappingsService } from '../services/mappings.service';
import { ProjectsService } from '../../projects/services/projects.service';
import { AuthService } from '../../../core/services/auth.service';
import { CreateMappingDto, UpdateMappingDto, AllocationSummary } from '../models/mapping.model';
import { Project } from '../../projects/models/project.model';

/** Option shape used by SelectButton for ratings. */
interface RatingOption {
  label: string;
  value: string;
}

/**
 * MappingFormComponent — create and edit form for program-project mappings.
 *
 * Routes:
 *  /mappings/new?projectId=X  — create mode (program_rep only)
 *  /mappings/:id/edit         — edit mode   (program_rep only, own pending)
 *
 * Features:
 *  - Project AutoComplete with API search; pre-filled when projectId query param present
 *  - Allocation % InputNumber (1–100) with live "remaining available" feedback
 *  - Complementarity and Efficiency ratings via SelectButton (optional)
 *  - Validation prevents submit when allocation would exceed remaining
 */
@Component({
  selector: 'app-mapping-form',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    CardModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    SelectModule,
    SelectButtonModule,
    ToastModule,
    DividerModule,
    ProgressSpinnerModule,
    SkeletonModule,
  ],
  providers: [MessageService],
  templateUrl: './mapping-form.component.html',
  styleUrl: './mapping-form.component.scss',
})
export class MappingFormComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly mappingsService = inject(MappingsService);
  private readonly projectsService = inject(ProjectsService);
  private readonly authService = inject(AuthService);
  private readonly messageService = inject(MessageService);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------

  /** Mapping ID (integer) when editing; null in create mode. */
  readonly mappingId = signal<number | null>(null);

  /** True while loading an existing mapping for edit. */
  readonly loadingMapping = signal(false);

  /** True while the form is being submitted. */
  readonly submitting = signal(false);

  /** The currently selected project (for allocation lookup). */
  readonly selectedProject = signal<Project | null>(null);

  /** Allocation summary for the selected project. */
  readonly allocationSummary = signal<AllocationSummary | null>(null);

  /** True while the allocation summary is being fetched. */
  readonly loadingAllocation = signal(false);

  /** All active projects for the Select dropdown. */
  readonly projects = signal<Project[]>([]);

  /** True while loading projects for the dropdown. */
  readonly loadingProjects = signal(false);

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  /** Human-readable page title. */
  readonly pageTitle = computed(() =>
    this.mappingId() ? 'Edit Mapping' : 'New Mapping',
  );

  /** Submit button label changes during submission. */
  readonly submitLabel = computed(() =>
    this.submitting()
      ? this.mappingId() ? 'Saving...' : 'Creating...'
      : this.mappingId() ? 'Save Changes' : 'Create Mapping',
  );

  /**
   * The remaining allocation percentage available for this project,
   * accounting for the currently-entered value when editing an existing mapping.
   * Returns null when no project is selected or the summary is loading.
   */
  readonly remainingAllocation = computed<number | null>(() => {
    const summary = this.allocationSummary();
    if (!summary) return null;

    // When editing, the existing mapping's allocation is "already counted"
    // in totalAllocated, so we add it back to get the true remaining capacity.
    if (this.mappingId()) {
      const currentValue = this.form.get('allocationPercentage')?.value ?? 0;
      // remaining + currentValue = max we can set
      return summary.remaining + currentValue;
    }
    return summary.remaining;
  });

  /** True when the entered allocation would exceed the available capacity. */
  readonly allocationExceedsRemaining = computed(() => {
    const remaining = this.remainingAllocation();
    if (remaining === null) return false;
    const entered = this.form.get('allocationPercentage')?.value ?? 0;
    return entered > remaining;
  });

  // -----------------------------------------------------------------------
  // SelectButton options
  // -----------------------------------------------------------------------

  readonly ratingOptions: RatingOption[] = [
    { label: 'High',   value: 'high' },
    { label: 'Medium', value: 'medium' },
    { label: 'Low',    value: 'low' },
  ];

  // -----------------------------------------------------------------------
  // Form
  // -----------------------------------------------------------------------

  /**
   * Reactive form with project (object) and allocationPercentage required;
   * complementarityRating and efficiencyRating are optional.
   */
  readonly form: FormGroup = this.fb.group({
    projectId:             [null, Validators.required],
    allocationPercentage:  [null, [Validators.required, Validators.min(1), Validators.max(100)]],
    complementarityRating: [null],
    efficiencyRating:      [null],
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async ngOnInit(): Promise<void> {
    // Route params are always strings — coerce to integers before service calls.
    const rawMappingId = this.route.snapshot.paramMap.get('id');
    const rawProjectId = this.route.snapshot.queryParamMap.get('projectId');

    const mappingId = rawMappingId ? Number(rawMappingId) : null;
    const projectId = rawProjectId ? Number(rawProjectId) : null;

    this.mappingId.set(mappingId);

    // Load all projects for the Select dropdown.
    await this.loadProjects();

    if (mappingId) {
      await this.loadMappingForEdit(mappingId);
    } else if (projectId) {
      await this.preloadProject(projectId);
    }
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  /** Fetches the existing mapping and patches the form. */
  private async loadMappingForEdit(id: number): Promise<void> {
    this.loadingMapping.set(true);
    try {
      const mapping = await firstValueFrom(this.mappingsService.getMapping(id));

      this.form.patchValue({
        projectId:             mapping.project.id,
        allocationPercentage:  mapping.allocationPercentage,
        complementarityRating: mapping.complementarityRating,
        efficiencyRating:      mapping.efficiencyRating,
      });

      this.selectedProject.set(mapping.project as any);
      await this.fetchAllocationSummary(mapping.project.id);
    } catch {
      this.messageService.add({
        severity: 'error',
        summary: 'Load Error',
        detail: 'Failed to load mapping data.',
      });
    } finally {
      this.loadingMapping.set(false);
    }
  }

  /** Pre-selects a project from the projectId query param. */
  private async preloadProject(projectId: number): Promise<void> {
    // Find from the already-loaded list first.
    let project = this.projects().find(p => p.id === projectId) ?? null;

    // If not in the list (shouldn't happen), fetch individually.
    if (!project) {
      try {
        project = await firstValueFrom(this.projectsService.getProject(projectId));
      } catch {
        return;
      }
    }

    this.form.patchValue({ projectId: project.id });
    this.selectedProject.set(project);
    await this.fetchAllocationSummary(project.id);
  }

  /** Fetches the allocation summary for the given project ID. */
  private async fetchAllocationSummary(projectId: number): Promise<void> {
    this.loadingAllocation.set(true);
    try {
      const summary = await firstValueFrom(
        this.mappingsService.getAllocationSummary(projectId),
      );
      this.allocationSummary.set(summary);
    } catch {
      this.allocationSummary.set(null);
    } finally {
      this.loadingAllocation.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Project loading & selection
  // -----------------------------------------------------------------------

  /** Loads all projects for the dropdown, paginating through the API. */
  private async loadProjects(): Promise<void> {
    this.loadingProjects.set(true);
    try {
      const all: Project[] = [];
      let page = 1;
      const limit = 100;
      let total = 0;

      do {
        const response = await firstValueFrom(
          this.projectsService.getProjects({ limit, page }),
        );
        all.push(...response.data);
        total = response.total;
        page++;
      } while (all.length < total);

      this.projects.set(all);
    } catch {
      this.projects.set([]);
    } finally {
      this.loadingProjects.set(false);
    }
  }

  /** Called when the Select value changes (select or clear). */
  onProjectChange(projectId: number | null): void {
    if (projectId) {
      const project = this.projects().find(p => p.id === projectId) ?? null;
      this.selectedProject.set(project);
      this.allocationSummary.set(null);
      this.fetchAllocationSummary(projectId);
    } else {
      this.selectedProject.set(null);
      this.allocationSummary.set(null);
    }
  }

  // -----------------------------------------------------------------------
  // Submission
  // -----------------------------------------------------------------------

  /** Validates the form and submits to create or update the mapping. */
  onSubmit(): void {
    this.form.markAllAsTouched();

    if (this.form.invalid || this.submitting()) return;
    if (this.allocationExceedsRemaining()) return;

    this.submitting.set(true);

    const raw = this.form.getRawValue();
    const id = this.mappingId();

    const request$ = id
      ? this.mappingsService.updateMapping(id, {
          allocationPercentage:  raw.allocationPercentage,
          complementarityRating: raw.complementarityRating ?? undefined,
          efficiencyRating:      raw.efficiencyRating ?? undefined,
        } as UpdateMappingDto)
      : this.mappingsService.createMapping({
          projectId:             raw.projectId,
          allocationPercentage:  raw.allocationPercentage,
          complementarityRating: raw.complementarityRating ?? undefined,
          efficiencyRating:      raw.efficiencyRating ?? undefined,
        } as CreateMappingDto);

    request$.subscribe({
      next: () => {
        this.submitting.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Saved',
          detail: id ? 'Mapping updated successfully.' : 'Mapping created successfully.',
        });
        // Brief delay so the Toast is visible before navigation.
        setTimeout(() => this.router.navigate(['/mappings']), 1200);
      },
      error: () => {
        this.submitting.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Save Error',
          detail: 'Failed to save mapping. Please try again.',
        });
      },
    });
  }

  /** Navigates back to the mappings list without saving. */
  onCancel(): void {
    this.router.navigate(['/mappings']);
  }

  // -----------------------------------------------------------------------
  // Validation helpers (used in template)
  // -----------------------------------------------------------------------

  /** Returns true when a control is invalid and has been touched. */
  isInvalid(controlName: string): boolean {
    const c = this.form.get(controlName);
    return !!(c?.invalid && c.touched);
  }

}
