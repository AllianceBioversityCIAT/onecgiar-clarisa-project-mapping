import { Component, OnInit, inject, signal, computed, effect } from '@angular/core';
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
import { CheckboxModule } from 'primeng/checkbox';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService, ConfirmationService } from 'primeng/api';

import { AnaplanBadgeComponent } from '../../../shared/components/anaplan-badge/anaplan-badge.component';
import { ProjectsService } from '../services/projects.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { AuthService } from '../../../core/services/auth.service';
import {
  CountryAllocation,
  CreateProjectDto,
  ProjectBudget,
  UNIT_ADMIN_EDITABLE_FIELDS,
  UnitAdminUpdateProjectPayload,
} from '../models/project.model';
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
  email: string | null;
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

/** Counts whitespace-separated words in a string. Empty / whitespace-only → 0. */
function countWords(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Custom validator: caps a text control at `max` whitespace-separated words.
 * Returns `{ maxWords: { max, actual } }` when exceeded so the template can
 * show the live count.
 */
function maxWords(max: number) {
  return (control: AbstractControl): ValidationErrors | null => {
    const actual = countWords(control.value);
    return actual > max ? { maxWords: { max, actual } } : null;
  };
}

/**
 * ProjectFormComponent — create and edit form for projects.
 *
 * Routes:
 *  /projects/new         — create mode (admin only)
 *  /projects/:id/edit    — edit mode   (admin + unit_admin)
 *
 * Role behaviour:
 *  - Admin: all non-Anaplan fields editable; justification optional.
 *  - Unit Admin / Center Rep (constrained edit): only the
 *    UNIT_ADMIN_EDITABLE_FIELDS whitelist enabled; code, center, countries,
 *    status, and all Anaplan fields are disabled. Justification is required
 *    (min 5 chars) — the metadata endpoint rejects an empty reason.
 *  - Others: route guard blocks access before the component loads.
 *
 * On submit: calls createProject / updateProject (admin) or
 * updateMetadata (unit_admin), shows a Toast, then navigates to the
 * project detail page on success.
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
    CheckboxModule,
    TooltipModule,
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
  private readonly authService = inject(AuthService);
  private readonly messageService = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);

  // -----------------------------------------------------------------------
  // Auth signals
  // -----------------------------------------------------------------------

  /** True when the current user is an admin. */
  readonly isAdmin = this.authService.isAdmin;

  /** True when the current user is a unit_admin (PPU/PCU). */
  readonly isUnitAdmin = this.authService.isUnitAdmin;

  /** True when the current user is a center_rep. */
  readonly isCenterRep = this.authService.isCenterRep;

  /**
   * True when the form should use the constrained metadata-edit path
   * (PATCH /projects/:id/metadata + whitelist + required justification).
   * Applies to unit_admin always, and to center_rep when editing a project
   * in their own center. Admin always uses the full edit path.
   */
  readonly usesConstrainedEdit = computed(() => this.isUnitAdmin() || this.isCenterRep());

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

  /**
   * Center id of the project being edited (set once the load-time guard
   * passes). Watched by `centerScopeEffect` so a center rep who switches
   * their active center away from this project mid-edit is redirected out.
   */
  readonly projectCenterId = signal<number | null>(null);

  readonly submitLabel = computed(() =>
    this.submitting()
      ? this.projectId()
        ? 'Saving...'
        : 'Creating...'
      : this.projectId()
        ? 'Save Changes'
        : 'Create Project',
  );

  /**
   * Whether the justification textarea should be shown.
   * Shown for any constrained-edit path (unit_admin, center_rep) or when
   * admin is editing an existing project.
   */
  readonly showJustification = computed(
    () => this.usesConstrainedEdit() || (this.isAdmin() && !!this.projectId()),
  );

  /**
   * Expose the whitelist constant to the template for *ngIf-style checks.
   * Used to highlight which fields are restricted for unit_admin.
   */
  readonly unitAdminEditableFields = UNIT_ADMIN_EDITABLE_FIELDS;

  // -----------------------------------------------------------------------
  // Dropdown options
  // -----------------------------------------------------------------------

  readonly fundingOptions: SelectOption[] = [
    { label: 'Window 3', value: 'window3' },
    { label: 'Bilateral', value: 'bilateral' },
    { label: 'SRV', value: 'srv' },
    { label: 'Other', value: 'other' },
  ];

  /** Definitions surfaced as tooltips on each funding source option. */
  readonly fundingDefinitions: Record<string, string> = {
    bilateral:
      'Funding that flows directly (not through the CGIAR Trust Fund) from a Funder to a Center in support of CGIAR Research.',
    window3: 'Funding that flows from the Trust Fund through Window 3 to a Center.',
    other: 'Funding provided by the Center from its own resources.',
  };

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
   *
   * The `justification` field is included for all roles but validators are
   * applied dynamically in ngOnInit based on whether the user is unit_admin.
   */
  readonly form: FormGroup = this.fb.group(
    {
      // --- Identification ---
      code: ['', Validators.required],
      name: ['', Validators.required],
      description: ['', [maxWords(5000)]],
      summary: ['', [Validators.required, maxWords(150)]],

      // --- Timeline ---
      startDate: [null, Validators.required],
      endDate: [null, Validators.required],

      // --- Budget & Funding ---
      totalBudget: [null, [Validators.required, Validators.min(0.01)]],
      remainingBudget: [null],
      fundingSource: [null, Validators.required],
      funder: [''],

      // --- Principal Investigator (editable by admin + center_rep) ---
      // Anaplan-authoritative — overwritten on the next CSV import — but
      // admins and center reps may correct the PI contact between imports.
      principalInvestigator: [''],
      // Optional field; when provided it must be a syntactically valid email
      // with a proper domain and TLD (Validators.email alone accepts "pi@host").
      email: ['', [Validators.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)]],

      // --- Center & geography ---
      centerId: [null, Validators.required],
      // Per-table Global toggles — when true, the matching FormArray is
      // ignored on submit (server clears the relation).
      isBenefitGlobal: [false],
      isImplementationGlobal: [false],
      // Per-country allocation rows (countryId + allocationPercentage).
      // Sum ≤ 100, each row > 0 — enforced by the form validators below.
      benefitCountries: this.fb.array([]),
      implementationCountries: this.fb.array([]),

      // --- Budget Breakdown (FormArray) ---
      budgets: this.fb.array([]),

      // --- Edit justification (shown for unit_admin always; for admin in edit mode) ---
      justification: [''],
    },
    { validators: endDateAfterStartDate },
  );

  // -----------------------------------------------------------------------
  // Global flag effects — when a Global toggle goes on, clear the matching
  // allocation FormArray so the form state mirrors what will be persisted.
  // -----------------------------------------------------------------------

  private readonly isBenefitGlobalEffect = effect(() => {
    const ctrl = this.form.get('isBenefitGlobal');
    if (!ctrl) return;
    ctrl.valueChanges.subscribe((val: boolean) => {
      if (val) this.benefitCountries.clear();
    });
  });

  private readonly isImplementationGlobalEffect = effect(() => {
    const ctrl = this.form.get('isImplementationGlobal');
    if (!ctrl) return;
    ctrl.valueChanges.subscribe((val: boolean) => {
      if (val) this.implementationCountries.clear();
    });
  });

  // -----------------------------------------------------------------------
  // Active-center scope guard — a center rep editing a project who switches
  // their active center (header switcher) to a different center can no longer
  // edit this project (backend would 403). Redirect them back to the view
  // instead of letting them save into a 403.
  // -----------------------------------------------------------------------
  private readonly centerScopeEffect = effect(() => {
    const activeCenterId = this.authService.effectiveCenterId();
    const projectCenterId = this.projectCenterId();
    const id = this.projectId();
    // Only relevant once an edit-mode project has cleared the load guard.
    if (!this.isCenterRep() || id === null || projectCenterId === null) return;
    if (activeCenterId !== projectCenterId) {
      this.messageService.add({
        severity: 'warn',
        summary: 'Center switched',
        detail: 'This project belongs to another center. Switch back to edit it.',
      });
      this.router.navigate(['/projects', id]);
    }
  });

  // -----------------------------------------------------------------------
  // FormArray accessors
  // -----------------------------------------------------------------------

  /** Typed accessor for the budgets FormArray. */
  get budgets(): FormArray {
    return this.form.get('budgets') as FormArray;
  }

  /** Typed accessor for the Location of Benefit allocations FormArray. */
  get benefitCountries(): FormArray {
    return this.form.get('benefitCountries') as FormArray;
  }

  /** Typed accessor for the Country of Implementation allocations FormArray. */
  get implementationCountries(): FormArray {
    return this.form.get('implementationCountries') as FormArray;
  }

  /** Sum of allocation_percentage in the Benefit table. Used for the
   *  running total / remaining indicator and submit-side validation. */
  benefitAllocationTotal(): number {
    return this.sumAllocations(this.benefitCountries);
  }

  /** Sum of allocation_percentage in the Implementation table. */
  implementationAllocationTotal(): number {
    return this.sumAllocations(this.implementationCountries);
  }

  /** Sum helper rounded to 2 dp to avoid FP display drift. */
  private sumAllocations(array: FormArray): number {
    let sum = 0;
    for (const row of array.controls) {
      const v = Number((row as FormGroup).get('allocationPercentage')?.value);
      if (Number.isFinite(v)) sum += v;
    }
    return Math.round(sum * 100) / 100;
  }

  /** Country IDs already selected in a given allocation FormArray — used
   *  to filter out duplicates from the country picker. */
  selectedCountryIds(array: FormArray): Set<number> {
    const ids = new Set<number>();
    for (const row of array.controls) {
      const id = (row as FormGroup).get('countryId')?.value;
      if (typeof id === 'number') ids.add(id);
    }
    return ids;
  }

  /** Appends a new allocation row to the given FormArray. */
  addCountryAllocation(array: FormArray, initial?: CountryAllocation): void {
    array.push(
      this.fb.group({
        countryId: [initial?.countryId ?? null, [Validators.required]],
        allocationPercentage: [
          initial?.allocationPercentage ?? null,
          [Validators.required, Validators.min(0.01), Validators.max(100)],
        ],
      }),
    );
  }

  /** Removes the allocation row at the given index. */
  removeCountryAllocation(array: FormArray, index: number): void {
    array.removeAt(index);
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

    // Apply role-based field restrictions once auth state is resolved.
    this.applyRoleFieldRestrictions();

    if (id) {
      await this.loadProjectForEdit(id);
    }
  }

  /**
   * Applies form control enable/disable rules based on the current user's role.
   *
   * Unit admin:
   *  - Only UNIT_ADMIN_EDITABLE_FIELDS are enabled; all others are disabled.
   *  - The `justification` field becomes required (min 5 chars).
   *
   * Constrained edit applies to BOTH unit_admin and center_rep
   * (usesConstrainedEdit), so center reps also see/need a required
   * justification.
   *
   * Admin:
   *  - All fields remain enabled (default form state).
   *  - Justification is optional.
   *
   * The {emitEvent: false} flag prevents unnecessary change-detection cycles.
   */
  private applyRoleFieldRestrictions(): void {
    // Anaplan-owned structural fields — immutable in edit mode for EVERY
    // role, super-admin included. They are populated by the CSV import
    // and must not drift via the API. New-project mode (no projectId)
    // still allows centerId/startDate/endDate so admins can register
    // projects that pre-date the next Anaplan import.
    if (this.projectId()) {
      const anaplanImmutable = [
        'code',
        'centerId',
        'startDate',
        'endDate',
        'fundingSource',
        'funder',
      ];
      for (const controlName of anaplanImmutable) {
        this.form.get(controlName)?.disable({ emitEvent: false });
      }
    }

    if (!this.usesConstrainedEdit()) {
      // Admin path: justification is optional, no further field restrictions.
      return;
    }

    // Constrained edit (unit_admin or center_rep): lock everything that
    // is NOT in the whitelist on top of the Anaplan immutability rule above.
    // Skipping 'budgets' FormArray — it is always read-only in edit mode
    // for everyone (Anaplan data); its controls are disabled via [readonly].
    const editableSet = new Set<string>(UNIT_ADMIN_EDITABLE_FIELDS);
    const nonArrayControls = [
      'code',
      'name',
      'description',
      'summary',
      'totalBudget',
      'remainingBudget',
      'fundingSource',
      'funder',
      'isBenefitGlobal',
      'isImplementationGlobal',
      'benefitCountries',
      'implementationCountries',
    ];

    for (const controlName of nonArrayControls) {
      const control = this.form.get(controlName);
      if (!control) continue;

      if (editableSet.has(controlName)) {
        control.enable({ emitEvent: false });
      } else {
        control.disable({ emitEvent: false });
      }
    }

    // Principal Investigator name + email are editable by center_rep but
    // NOT unit_admin (the backend rejects PI edits from unit_admin). They
    // sit outside the shared whitelist precisely so they can carry these
    // per-role rules.
    const piEditable = this.isCenterRep();
    for (const controlName of ['principalInvestigator', 'email']) {
      const control = this.form.get(controlName);
      if (!control) continue;
      if (piEditable) {
        control.enable({ emitEvent: false });
      } else {
        control.disable({ emitEvent: false });
      }
    }

    // Justification is required on any constrained edit (unit_admin AND
    // center_rep) — the metadata endpoint rejects an empty reason.
    this.form.get('justification')!.setValidators([Validators.required, Validators.minLength(5)]);
    this.form.get('justification')!.updateValueAndValidity({ emitEvent: false });
  }

  // -----------------------------------------------------------------------
  // Edit mode — load existing project
  // -----------------------------------------------------------------------

  /** Fetches the project and patches the form with existing values. */
  private async loadProjectForEdit(id: number): Promise<void> {
    this.loadingProject.set(true);
    try {
      const project = await firstValueFrom(this.projectsService.getProject(id));

      // Center-scope guard for center_rep: only their own center's
      // projects are editable. Backend enforces the same; this just
      // surfaces a clean message instead of letting a 403 land.
      if (this.isCenterRep()) {
        // Scope by the active center (matches the X-Active-Center overlay the
        // backend enforces and the edit-button gate in project-detail), not the
        // primary center — otherwise a multi-center rep who switched to a
        // non-primary center gets bounced back to the view.
        const userCenterId = this.authService.effectiveCenterId();
        if (userCenterId === null || project.center?.id !== userCenterId) {
          this.messageService.add({
            severity: 'error',
            summary: 'Not allowed',
            detail: 'You can only edit projects from your own center.',
          });
          this.router.navigate(['/projects', id]);
          return;
        }
        // Guard passed — remember the center so a later active-center switch
        // can re-evaluate access via `centerScopeEffect`.
        this.projectCenterId.set(project.center?.id ?? null);
      }

      this.form.patchValue({
        code: project.code,
        name: project.name,
        description: project.description ?? '',
        summary: project.summary ?? '',
        startDate: project.startDate ? new Date(project.startDate) : null,
        endDate: project.endDate ? new Date(project.endDate) : null,
        totalBudget: project.totalBudget,
        remainingBudget: project.remainingBudget ?? null,
        centerId: project.center?.id ?? null,
        isBenefitGlobal: project.isBenefitGlobal ?? false,
        isImplementationGlobal: project.isImplementationGlobal ?? false,
        fundingSource: project.fundingSource,
        funder: project.funder ?? '',
        principalInvestigator: project.principalInvestigator ?? '',
        email: project.email ?? '',
      });

      // Rebuild country-allocation FormArrays from the server payload.
      this.benefitCountries.clear();
      (project.benefitCountries ?? []).forEach((row) =>
        this.addCountryAllocation(this.benefitCountries, row),
      );
      this.implementationCountries.clear();
      (project.implementationCountries ?? []).forEach((row) =>
        this.addCountryAllocation(this.implementationCountries, row),
      );

      // Store Anaplan-sourced fields for read-only display (never submitted).
      this.anaplanData.set({
        principalInvestigator: project.principalInvestigator ?? null,
        email: project.email ?? null,
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

    // Surface allocation-sum validation before sending — both tables
    // are independently capped at 100%.
    if (!this.form.get('isBenefitGlobal')?.value) {
      if (this.benefitAllocationTotal() > 100) {
        this.messageService.add({
          severity: 'error',
          summary: 'Validation',
          detail: 'Location of Benefit allocations cannot exceed 100%.',
        });
        return;
      }
    }
    if (!this.form.get('isImplementationGlobal')?.value) {
      if (this.implementationAllocationTotal() > 100) {
        this.messageService.add({
          severity: 'error',
          summary: 'Validation',
          detail: 'Country of Implementation allocations cannot exceed 100%.',
        });
        return;
      }
    }

    // Unit admin and center rep use the same constrained endpoint
    // (PATCH /projects/:id/metadata) — admin uses the full edit path.
    if (this.usesConstrainedEdit()) {
      this.submitAsUnitAdmin();
      return;
    }

    this.submitAsAdmin();
  }

  /** Builds the wire-format allocation rows from a FormArray, stripping
   *  the country hydrate that comes back on reads but is not part of
   *  the DTO. */
  private collectAllocations(
    array: FormArray,
  ): { countryId: number; allocationPercentage: number }[] {
    return array.controls
      .map((row) => {
        const g = row as FormGroup;
        return {
          countryId: Number(g.get('countryId')?.value),
          allocationPercentage: Number(g.get('allocationPercentage')?.value),
        };
      })
      .filter(
        (r) =>
          Number.isFinite(r.countryId) &&
          Number.isFinite(r.allocationPercentage) &&
          r.allocationPercentage > 0,
      );
  }

  /**
   * Submit path for the constrained metadata-edit endpoint
   * (unit_admin, center_rep): builds a whitelist-only payload and calls
   * PATCH /projects/:id/metadata. The justification field is required.
   */
  private submitAsUnitAdmin(): void {
    const id = this.projectId();
    if (!id) return; // constrained edit is update-only — no create path

    this.submitting.set(true);
    const raw = this.form.getRawValue();

    // Build payload from whitelisted fields only.
    const payload: UnitAdminUpdateProjectPayload = {
      justification: raw.justification?.trim() ?? '',
    };

    if (raw.name) payload.name = raw.name.trim();
    if (raw.description !== null && raw.description !== undefined)
      payload.description = raw.description.trim();
    if (raw.summary !== null && raw.summary !== undefined) payload.summary = raw.summary.trim();
    if (raw.totalBudget != null) payload.totalBudget = raw.totalBudget;
    if (raw.remainingBudget != null) payload.remainingBudget = raw.remainingBudget;
    // PI contact — only center_rep edits these via the metadata endpoint
    // (unit_admin's controls are disabled and the backend rejects PI from
    // unit_admin). Send empty strings so the value can be cleared.
    if (this.isCenterRep()) {
      payload.principalInvestigator = (raw.principalInvestigator ?? '').trim();
      payload.email = (raw.email ?? '').trim();
    }
    // Location of Benefit + Country of Implementation — always send the
    // Global flags and matching allocations so the backend can apply the
    // "global wins" rule deterministically (global=true clears the list).
    payload.isBenefitGlobal = raw.isBenefitGlobal ?? false;
    payload.benefitCountries = raw.isBenefitGlobal
      ? []
      : this.collectAllocations(this.benefitCountries);
    payload.isImplementationGlobal = raw.isImplementationGlobal ?? false;
    payload.implementationCountries = raw.isImplementationGlobal
      ? []
      : this.collectAllocations(this.implementationCountries);

    this.projectsService.updateMetadata(id, payload).subscribe({
      next: () => {
        this.submitting.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Saved',
          detail: 'Project metadata updated successfully.',
        });
        // Navigate to the project detail so the user can see the audit tab.
        setTimeout(() => this.router.navigate(['/projects', id]), 1200);
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

  /**
   * Submit path for admin: builds the full CreateProjectDto and calls
   * the existing create or update endpoint. Includes optional justification.
   */
  private submitAsAdmin(): void {
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

    const id = this.projectId();

    // Anaplan-immutable fields (code, centerId, startDate, endDate,
    // fundingSource, funder) only belong on the CREATE payload — the
    // update DTO rejects them outright so the source of truth (CSV
    // import) is never overwritten via API.
    const dto: (CreateProjectDto | Partial<CreateProjectDto>) & {
      justification?: string;
    } = {
      ...(id
        ? {}
        : {
            code: raw.code.trim(),
            startDate: this.toIsoDate(raw.startDate),
            endDate: this.toIsoDate(raw.endDate),
            centerId: raw.centerId,
            fundingSource: raw.fundingSource,
            funder: raw.funder?.trim() || undefined,
          }),
      name: raw.name.trim(),
      description: raw.description?.trim() || undefined,
      summary: raw.summary?.trim() || undefined,
      totalBudget: raw.totalBudget,
      remainingBudget: raw.remainingBudget ?? undefined,
      // PI contact — editable by admin on create + update.
      principalInvestigator: raw.principalInvestigator?.trim() || undefined,
      email: raw.email?.trim() || undefined,
      isBenefitGlobal: raw.isBenefitGlobal ?? false,
      benefitCountries: raw.isBenefitGlobal ? [] : this.collectAllocations(this.benefitCountries),
      isImplementationGlobal: raw.isImplementationGlobal ?? false,
      implementationCountries: raw.isImplementationGlobal
        ? []
        : this.collectAllocations(this.implementationCountries),

      // Budget breakdown
      budgets: budgets.length > 0 ? budgets : undefined,

      // Optional justification for admin edits — backend records audit row if present.
      ...(raw.justification?.trim() ? { justification: raw.justification.trim() } : {}),
    };

    const request$ = id
      ? this.projectsService.updateProject(id, dto)
      : this.projectsService.createProject(dto as CreateProjectDto);

    request$.subscribe({
      next: () => {
        this.submitting.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Saved',
          detail: id ? 'Project updated successfully.' : 'Project created successfully.',
        });
        // Navigate to the project detail on edit, or back to list on create.
        const dest = id ? ['/projects', id] : ['/projects'];
        setTimeout(() => this.router.navigate(dest), 1200);
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

  /** Live word count for the summary field — drives the "X / 150 words" hint. */
  get summaryWordCount(): number {
    return countWords(this.form.get('summary')?.value);
  }

  /** Hard cap surfaced in the template alongside the live count. */
  readonly summaryMaxWords = 150;

  /** Live word count for the description field — drives the "X / 5000 words" hint. */
  get descriptionWordCount(): number {
    return countWords(this.form.get('description')?.value);
  }

  /** Hard cap surfaced in the template alongside the live count. */
  readonly descriptionMaxWords = 5000;

  /** True when the justification field is invalid and has been touched. */
  get justificationError(): string | null {
    const c = this.form.get('justification');
    if (!c || !c.touched || !c.invalid) return null;
    if (c.hasError('required')) return 'Justification is required.';
    if (c.hasError('minlength')) return 'Justification must be at least 5 characters.';
    return null;
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
