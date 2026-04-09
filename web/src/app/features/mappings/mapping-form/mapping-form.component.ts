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
import { AutoCompleteModule, AutoCompleteCompleteEvent } from 'primeng/autocomplete';
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
    AutoCompleteModule,
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

  /** Mapping ID when editing; null in create mode. */
  readonly mappingId = signal<string | null>(null);

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

  /** Projects returned by the AutoComplete search. */
  readonly projectSuggestions = signal<Project[]>([]);

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
    project:               [null, Validators.required],
    allocationPercentage:  [null, [Validators.required, Validators.min(1), Validators.max(100)]],
    complementarityRating: [null],
    efficiencyRating:      [null],
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async ngOnInit(): Promise<void> {
    const mappingId = this.route.snapshot.paramMap.get('id');
    const projectId = this.route.snapshot.queryParamMap.get('projectId');

    this.mappingId.set(mappingId);

    if (mappingId) {
      // Edit mode: load existing mapping data.
      await this.loadMappingForEdit(mappingId);
    } else if (projectId) {
      // Create mode with pre-filled project from query param.
      await this.preloadProject(projectId);
    }
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  /** Fetches the existing mapping and patches the form. */
  private async loadMappingForEdit(id: string): Promise<void> {
    this.loadingMapping.set(true);
    try {
      const mapping = await firstValueFrom(this.mappingsService.getMapping(id));

      // Fetch the full project so AutoComplete shows the correct object.
      const project = await firstValueFrom(
        this.projectsService.getProject(mapping.project.id),
      );

      this.form.patchValue({
        project:               project,
        allocationPercentage:  mapping.allocationPercentage,
        complementarityRating: mapping.complementarityRating,
        efficiencyRating:      mapping.efficiencyRating,
      });

      this.selectedProject.set(project);
      await this.fetchAllocationSummary(project.id);
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

  /** Pre-loads a project from the projectId query param. */
  private async preloadProject(projectId: string): Promise<void> {
    try {
      const project = await firstValueFrom(this.projectsService.getProject(projectId));
      this.form.patchValue({ project });
      this.selectedProject.set(project);
      await this.fetchAllocationSummary(projectId);
    } catch {
      // Silently ignore — user can still search for projects.
    }
  }

  /** Fetches the allocation summary for the given project ID. */
  private async fetchAllocationSummary(projectId: string): Promise<void> {
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
  // AutoComplete handlers
  // -----------------------------------------------------------------------

  /**
   * Called by p-autoComplete (completeMethod) — searches projects by name.
   */
  searchProjects(event: AutoCompleteCompleteEvent): void {
    const query = event.query?.trim();
    if (!query || query.length < 2) {
      this.projectSuggestions.set([]);
      return;
    }

    this.projectsService.getProjects({ search: query, limit: 10, page: 1 }).subscribe({
      next: response => this.projectSuggestions.set(response.data),
      error: () => this.projectSuggestions.set([]),
    });
  }

  /**
   * Called when the user selects a project from the AutoComplete dropdown.
   * Triggers an allocation summary fetch for the selected project.
   */
  onProjectSelect(project: Project): void {
    this.selectedProject.set(project);
    this.allocationSummary.set(null);
    this.fetchAllocationSummary(project.id);
  }

  /**
   * Called when the user clears the AutoComplete field.
   */
  onProjectClear(): void {
    this.selectedProject.set(null);
    this.allocationSummary.set(null);
    this.form.patchValue({ project: null });
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
          projectId:             raw.project.id,
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

  /** Label shown in the AutoComplete input for a selected project. */
  projectFieldLabel(project: Project): string {
    return project ? `${project.code} — ${project.name}` : '';
  }
}
