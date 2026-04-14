import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule, CurrencyPipe } from '@angular/common';
import {
  ReactiveFormsModule,
  FormBuilder,
  FormGroup,
  FormArray,
  FormControl,
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

import { AnaplanBadgeComponent } from '../../../shared/components/anaplan-badge/anaplan-badge.component';
import { ProjectsService } from '../services/projects.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { CreateProjectDto, ProjectBudget } from '../models/project.model';
import { Center, Country } from '../../../core/models/reference-data.model';

/** Dropdown option shape used by PrimeNG Dropdown / MultiSelect. */
interface SelectOption {
  label: string;
  /** number for entity IDs (center, country); string for enum values (fundingSource, etc). */
  value: number | string;
}

/**
 * Anaplan-sourced fields stored for read-only display in edit mode.
 * These fields are never submitted back to the API.
 */
interface AnaplanData {
  principalInvestigator: string | null;
  signedContractTitle: string | null;
  funderPrimaryCenter: string | null;
  natureOfFunder: string | null;
  category: string | null;
  csp: string | null;
  cspNonCollectionReason: string | null;
  totalPledge: number | null;
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
    AnaplanBadgeComponent,
  ],
  providers: [MessageService, ConfirmationService, CurrencyPipe],
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

  /** Project ID (integer) when in edit mode; null in create mode. */
  readonly projectId = signal<number | null>(null);

  /** True when loading an existing project for edit. */
  readonly loadingProject = signal(false);

  /** True while the form submission is in flight. */
  readonly submitting = signal(false);

  /** Human-readable page title changes based on mode. */
  readonly pageTitle = computed(() => (this.projectId() ? 'Edit Project' : 'New Project'));

  /**
   * Anaplan-sourced fields populated in edit mode.
   * These are never part of the form — displayed read-only only.
   */
  readonly anaplanData = signal<AnaplanData | null>(null);

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
    { label: 'Window 3', value: 'window3' },
    { label: 'Bilateral', value: 'bilateral' },
    { label: 'SRV', value: 'srv' },
    { label: 'Other', value: 'other' },
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
      // --- Identification ---
      code: ['', Validators.required],
      name: ['', Validators.required],
      description: [''],
      summary: [''],
      results: [''],

      // --- Timeline ---
      startDate: [null, Validators.required],
      endDate: [null, Validators.required],

      // --- Budget & Funding ---
      totalBudget: [null, [Validators.required, Validators.min(0.01)]],
      remainingBudget: [null],
      fundingSource: [null, Validators.required],
      funder: [''],

      // --- Center & Location ---
      centerId: [null, Validators.required],
      countryIds: [[]],

      // --- Budget Breakdown (FormArray) ---
      budgets: this.fb.array([]),
    },
    { validators: endDateAfterStartDate },
  );

  // -----------------------------------------------------------------------
  // FormArray accessor
  // -----------------------------------------------------------------------

  /** Typed accessor for the budgets FormArray. */
  get budgets(): FormArray {
    return this.form.get('budgets') as FormArray;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async ngOnInit(): Promise<void> {
    // Load reference data in parallel with any project fetch.
    this.refData.loadCenters();
    this.refData.loadCountries();

    // Determine edit vs create mode from the route snapshot.
    // Route params are always strings — coerce to integer for the service layer.
    const raw = this.route.snapshot.paramMap.get('id');
    const id = raw ? Number(raw) : null;
    this.projectId.set(id);

    if (id) {
      await this.loadProjectForEdit(id);
    }
  }

  // -----------------------------------------------------------------------
  // Edit mode — load existing project
  // -----------------------------------------------------------------------

  /** Fetches the project and patches the form with existing values. */
  private async loadProjectForEdit(id: number): Promise<void> {
    this.loadingProject.set(true);
    try {
      const project = await firstValueFrom(this.projectsService.getProject(id));

      this.form.patchValue({
        code: project.code,
        name: project.name,
        description: project.description ?? '',
        summary: project.summary ?? '',
        results: project.results ?? '',
        startDate: project.startDate ? new Date(project.startDate) : null,
        endDate: project.endDate ? new Date(project.endDate) : null,
        totalBudget: project.totalBudget,
        remainingBudget: project.remainingBudget ?? null,
        centerId: project.center?.id ?? null,
        countryIds: project.countries?.map((c) => c.id) ?? [],
        fundingSource: project.fundingSource,
        funder: project.funder ?? '',
      });

      // Store Anaplan-sourced fields for read-only display (never submitted).
      this.anaplanData.set({
        principalInvestigator: project.principalInvestigator ?? null,
        signedContractTitle: project.signedContractTitle ?? null,
        funderPrimaryCenter: project.funderPrimaryCenter ?? null,
        natureOfFunder: project.natureOfFunder ?? null,
        category: project.category ?? null,
        csp: project.csp ?? null,
        cspNonCollectionReason: project.cspNonCollectionReason ?? null,
        totalPledge: project.totalPledge ?? null,
      });

      // Rebuild the budgets FormArray from existing rows.
      this.budgets.clear();
      (project.budgets ?? []).forEach((b) => this.addBudgetRow(b));
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
  // Budget FormArray helpers
  // -----------------------------------------------------------------------

  /**
   * Adds a new budget row FormGroup to the budgets FormArray.
   * Call with an existing budget object when rebuilding in edit mode,
   * or with no arguments to add an empty row.
   */
  addBudgetRow(initial?: Partial<ProjectBudget>): void {
    const row = this.fb.group({
      id: new FormControl<number | null>(initial?.id ?? null),
      year: [initial?.year ?? '', Validators.required],
      version: [initial?.version ?? '', Validators.required],
      account: [initial?.account ?? '', Validators.required],
      amount: [initial?.amount ?? 0, [Validators.required, Validators.min(0)]],
      externalCode: [initial?.externalCode ?? null],
    });
    this.budgets.push(row);
  }

  /**
   * Removes the budget row at the given index from the FormArray.
   */
  removeBudgetRow(index: number): void {
    this.budgets.removeAt(index);
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

    // Map budget rows, stripping nullish id so new rows don't send id: null.
    const budgets: ProjectBudget[] = (raw.budgets ?? []).map(
      (b: {
        id: number | null;
        year: string;
        version: string;
        account: string;
        amount: number;
        externalCode: string | null;
      }) => ({
        ...(b.id != null ? { id: b.id } : {}),
        year: b.year,
        version: b.version,
        account: b.account,
        amount: b.amount,
        ...(b.externalCode ? { externalCode: b.externalCode } : {}),
      }),
    );

    const dto: CreateProjectDto = {
      code: raw.code.trim(),
      name: raw.name.trim(),
      description: raw.description?.trim() || undefined,
      summary: raw.summary?.trim() || undefined,
      results: raw.results?.trim() || undefined,
      startDate: this.toIsoDate(raw.startDate),
      endDate: this.toIsoDate(raw.endDate),
      totalBudget: raw.totalBudget,
      remainingBudget: raw.remainingBudget ?? undefined,
      fundingSource: raw.fundingSource,
      funder: raw.funder?.trim() || undefined,
      centerId: raw.centerId,
      countryIds: raw.countryIds ?? [],

      // Budget breakdown
      budgets: budgets.length > 0 ? budgets : undefined,
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
    return !!(this.form.hasError('endBeforeStart') && this.form.get('endDate')?.touched);
  }

  /**
   * Returns true when a control inside a budget FormGroup row is invalid and touched.
   * rowIndex is the index in the budgets FormArray; controlName is the field name.
   */
  isBudgetRowInvalid(rowIndex: number, controlName: string): boolean {
    const row = this.budgets.at(rowIndex) as FormGroup;
    const c = row?.get(controlName);
    return !!(c?.invalid && c.touched);
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
