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
  AbstractControl,
  ValidationErrors,
} from '@angular/forms';
import { firstValueFrom } from 'rxjs';

// PrimeNG imports
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { InputNumberModule } from 'primeng/inputnumber';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { DividerModule } from 'primeng/divider';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { MessageService, ConfirmationService } from 'primeng/api';

import { ProjectsService } from '../services/projects.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { CreateProjectDto } from '../models/project.model';
import { Center, Country } from '../../../core/models/reference-data.model';

/** Dropdown option shape used by PrimeNG Dropdown / MultiSelect. */
interface SelectOption {
  label: string;
  value: string;
}

/**
 * Custom validator: ensures the endDate control's value is strictly
 * after the startDate control's value.
 *
 * Applied at the FormGroup level so both controls are accessible.
 */
function endDateAfterStartDate(group: AbstractControl): ValidationErrors | null {
  const start = group.get('startDate')?.value;
  const end = group.get('endDate')?.value;

  if (!start || !end) return null;

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();

  return endMs > startMs ? null : { endBeforeStart: true };
}

/**
 * ProjectFormComponent — create and edit form for projects.
 *
 * Routes:
 *  /projects/new         — create mode (admin only)
 *  /projects/:id/edit    — edit mode   (admin only)
 *
 * On submit: calls createProject or updateProject, shows a Toast,
 * then navigates to the project list on success.
 *
 * "Cancel" opens a ConfirmDialog when the form is dirty.
 */
@Component({
  selector: 'app-project-form',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    CardModule,
    ButtonModule,
    InputTextModule,
    TextareaModule,
    InputNumberModule,
    SelectModule,
    MultiSelectModule,
    DatePickerModule,
    DividerModule,
    ToastModule,
    ConfirmDialogModule,
    ProgressSpinnerModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './project-form.component.html',
  styleUrl: './project-form.component.scss',
})
export class ProjectFormComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly projectsService = inject(ProjectsService);
  private readonly refData = inject(ReferenceDataService);
  private readonly messageService = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  /** Project ID when in edit mode; null in create mode. */
  readonly projectId = signal<string | null>(null);

  /** True when loading an existing project for edit. */
  readonly loadingProject = signal(false);

  /** True while the form submission is in flight. */
  readonly submitting = signal(false);

  /** Human-readable page title changes based on mode. */
  readonly pageTitle = computed(() =>
    this.projectId() ? 'Edit Project' : 'New Project',
  );

  readonly submitLabel = computed(() =>
    this.submitting()
      ? this.projectId()
        ? 'Saving...'
        : 'Creating...'
      : this.projectId()
        ? 'Save Changes'
        : 'Create Project',
  );

  // -----------------------------------------------------------------------
  // Dropdown options
  // -----------------------------------------------------------------------

  readonly fundingOptions: SelectOption[] = [
    { label: 'Window 3',  value: 'window3' },
    { label: 'Bilateral', value: 'bilateral' },
    { label: 'SRV',       value: 'srv' },
    { label: 'Other',     value: 'other' },
  ];

  readonly centerOptions = computed<SelectOption[]>(() =>
    this.refData.centers().map((c: Center) => ({
      label: `${c.acronym} — ${c.name}`,
      value: c.id,
    })),
  );

  readonly countryOptions = computed<SelectOption[]>(() =>
    this.refData.countries().map((c: Country) => ({
      label: c.name,
      value: c.id,
    })),
  );

  // -----------------------------------------------------------------------
  // Form
  // -----------------------------------------------------------------------

  /**
   * Reactive form covering all project fields.
   * Group-level endDateAfterStartDate validator enforces chronological order.
   */
  readonly form: FormGroup = this.fb.group(
    {
      code:             ['', Validators.required],
      name:             ['', Validators.required],
      description:      [''],
      summary:          [''],
      results:          [''],
      startDate:        [null, Validators.required],
      endDate:          [null, Validators.required],
      totalBudget:      [null, [Validators.required, Validators.min(0.01)]],
      remainingBudget:  [null],
      centerId:         [null, Validators.required],
      countryIds:       [[]],
      fundingSource:    [null, Validators.required],
      funder:           [''],
    },
    { validators: endDateAfterStartDate },
  );

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async ngOnInit(): Promise<void> {
    // Load reference data in parallel with any project fetch.
    this.refData.loadCenters();
    this.refData.loadCountries();

    // Determine edit vs create mode from the route snapshot.
    const id = this.route.snapshot.paramMap.get('id');
    this.projectId.set(id);

    if (id) {
      await this.loadProjectForEdit(id);
    }
  }

  // -----------------------------------------------------------------------
  // Edit mode — load existing project
  // -----------------------------------------------------------------------

  /** Fetches the project and patches the form with existing values. */
  private async loadProjectForEdit(id: string): Promise<void> {
    this.loadingProject.set(true);
    try {
      const project = await firstValueFrom(this.projectsService.getProject(id));

      this.form.patchValue({
        code:            project.code,
        name:            project.name,
        description:     project.description ?? '',
        summary:         project.summary ?? '',
        results:         project.results ?? '',
        startDate:       project.startDate ? new Date(project.startDate) : null,
        endDate:         project.endDate ? new Date(project.endDate) : null,
        totalBudget:     project.totalBudget,
        remainingBudget: project.remainingBudget ?? null,
        centerId:        project.center?.id ?? null,
        countryIds:      project.countries?.map(c => c.id) ?? [],
        fundingSource:   project.fundingSource,
        funder:          project.funder ?? '',
      });
    } catch {
      this.messageService.add({
        severity: 'error',
        summary: 'Load Error',
        detail: 'Failed to load project data.',
      });
    } finally {
      this.loadingProject.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Submission
  // -----------------------------------------------------------------------

  /** Handles form submit — validates, builds DTO, calls create or update. */
  onSubmit(): void {
    this.form.markAllAsTouched();

    if (this.form.invalid || this.submitting()) return;

    this.submitting.set(true);

    const raw = this.form.getRawValue();
    const dto: CreateProjectDto = {
      code:          raw.code.trim(),
      name:          raw.name.trim(),
      description:   raw.description?.trim() || undefined,
      summary:       raw.summary?.trim() || undefined,
      results:       raw.results?.trim() || undefined,
      startDate:     this.toIsoDate(raw.startDate),
      endDate:       this.toIsoDate(raw.endDate),
      totalBudget:   raw.totalBudget,
      remainingBudget: raw.remainingBudget ?? undefined,
      fundingSource: raw.fundingSource,
      funder:        raw.funder?.trim() || undefined,
      centerId:      raw.centerId,
      countryIds:    raw.countryIds ?? [],
    };

    const id = this.projectId();
    const request$ = id
      ? this.projectsService.updateProject(id, dto)
      : this.projectsService.createProject(dto);

    request$.subscribe({
      next: () => {
        this.submitting.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Saved',
          detail: id ? 'Project updated successfully.' : 'Project created successfully.',
        });
        // Brief delay so the Toast is visible before navigation.
        setTimeout(() => this.router.navigate(['/projects']), 1200);
      },
      error: () => {
        this.submitting.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Save Error',
          detail: 'Failed to save project. Please try again.',
        });
      },
    });
  }

  // -----------------------------------------------------------------------
  // Cancel with unsaved changes guard
  // -----------------------------------------------------------------------

  /**
   * If the form is dirty, shows a ConfirmDialog before navigating away.
   * If the form is pristine, navigates immediately.
   */
  onCancel(): void {
    if (!this.form.dirty) {
      this.router.navigate(['/projects']);
      return;
    }

    this.confirmationService.confirm({
      header: 'Unsaved Changes',
      message: 'You have unsaved changes. Leave without saving?',
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Leave',
      rejectLabel: 'Stay',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.router.navigate(['/projects']),
    });
  }

  // -----------------------------------------------------------------------
  // Validation helpers (used in template)
  // -----------------------------------------------------------------------

  /** Returns true when a control is invalid and has been touched. */
  isInvalid(controlName: string): boolean {
    const c = this.form.get(controlName);
    return !!(c?.invalid && c.touched);
  }

  /** True when the group-level endBeforeStart error is active and endDate is touched. */
  get endDateError(): boolean {
    return !!(
      this.form.hasError('endBeforeStart') &&
      this.form.get('endDate')?.touched
    );
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  /** Converts a Date object to an ISO 8601 date-only string (YYYY-MM-DD). */
  private toIsoDate(date: Date | string | null): string {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().split('T')[0];
  }
}
