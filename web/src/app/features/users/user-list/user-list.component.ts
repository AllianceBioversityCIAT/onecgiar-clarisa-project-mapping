import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  FormsModule,
  Validators,
} from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, takeUntil } from 'rxjs';

// PrimeNG imports
import { TableModule } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { TagModule } from 'primeng/tag';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SkeletonModule } from 'primeng/skeleton';
import { ToastModule } from 'primeng/toast';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TabsModule } from 'primeng/tabs';
import { MessageService, ConfirmationService } from 'primeng/api';

import { UsersService } from '../services/users.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { AuthService } from '../../../core/services/auth.service';
import { UserWithRelations, UpdateUserDto, CreateUserDto } from '../models/user-management.model';
import { User } from '../../../core/models/user.model';
import { environment } from '../../../../environments/environment';
import { UserAuditTabComponent } from '../../admin/users/user-audit-tab.component';

/** Role option for the edit/create dialog Select. */
interface RoleOption {
  label: string;
  value: User['role'];
}

/**
 * UserListComponent — admin-only user management page.
 *
 * Features:
 *  - Paginated PrimeNG table listing all system users with role/status badges
 *  - Client-side search filter on name + email
 *  - Show/hide inactive users toggle with opacity dimming for inactive rows
 *  - Edit dialog with role, linked program/center, and active-status controls
 *  - Create dialog to pre-provision new users by email
 *  - Per-row deactivate action with ConfirmDialog (soft delete, isActive = false)
 *  - Role-conditional program/center Select fields
 *  - Toast feedback on save success/failure
 */
@Component({
  selector: 'app-user-list',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    TableModule,
    ButtonModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    TagModule,
    DialogModule,
    SelectModule,
    ToggleSwitchModule,
    SkeletonModule,
    ToastModule,
    TooltipModule,
    ConfirmDialogModule,
    TabsModule,
    UserAuditTabComponent,
  ],
  providers: [MessageService],
  templateUrl: './user-list.component.html',
  styleUrl: './user-list.component.scss',
})
export class UserListComponent implements OnInit, OnDestroy {
  private readonly usersService = inject(UsersService);
  private readonly refData = inject(ReferenceDataService);
  private readonly authService = inject(AuthService);
  private readonly fb = inject(FormBuilder);
  private readonly messageService = inject(MessageService);
  /** ConfirmationService is provided globally in app.config.ts. */
  private readonly confirmationService = inject(ConfirmationService);
  private readonly destroy$ = new Subject<void>();

  // -------------------------------------------------------------------------
  // State signals
  // -------------------------------------------------------------------------

  /** Full user list from API (unfiltered). */
  readonly users = signal<UserWithRelations[]>([]);

  /** True while the initial list fetch is in progress. */
  readonly loading = signal(true);

  /** True while an edit save is being submitted. */
  readonly saving = signal(false);

  /** True while a create save is being submitted. */
  readonly creating = signal(false);

  /** Controls edit-dialog visibility. */
  readonly dialogVisible = signal(false);

  /** Active tab in the edit dialog: 0 = Edit, 1 = History. */
  readonly editDialogActiveTab = signal<number>(0);

  /** Controls create-dialog visibility. */
  readonly showCreateDialog = signal(false);

  /** The user currently being edited (null = dialog closed). */
  readonly editingUser = signal<UserWithRelations | null>(null);

  /** Client-side search string. */
  readonly searchText = signal('');

  /** When true, inactive users are included in the table. */
  readonly showInactive = signal(false);

  /**
   * Linked-entity type filter. `null` = no filter; `'program'` keeps users
   * with a linked program; `'center'` keeps users with a linked center;
   * `'none'` keeps users with neither.
   */
  readonly linkedEntityFilter = signal<'program' | 'center' | 'none' | null>(null);

  /** Selected program id filter (null = any). */
  readonly programFilter = signal<number | null>(null);

  /** Selected center id filter (null = any). */
  readonly centerFilter = signal<number | null>(null);

  // -------------------------------------------------------------------------
  // Computed
  // -------------------------------------------------------------------------

  /** Programs list from reference data for the Select. */
  readonly programs = this.refData.programs;

  /** Centers list from reference data for the Select. */
  readonly centers = this.refData.centers;

  /**
   * Filtered user list applying text search, active toggle, linked-entity
   * type filter, and per-program / per-center filters. All filters AND
   * together — picking a Program implicitly forces the linked-entity type
   * to `program` from the user's perspective, but we still respect both
   * controls independently so the admin can spot inconsistencies.
   */
  readonly filteredUsers = computed(() => {
    const q = this.searchText().toLowerCase().trim();
    const includeInactive = this.showInactive();
    const entityType = this.linkedEntityFilter();
    const programId = this.programFilter();
    const centerId = this.centerFilter();

    return this.users().filter((u) => {
      // Active filter: hide inactive users unless the toggle is on
      if (!includeInactive && !u.isActive) return false;

      // Linked-entity type filter
      if (entityType === 'program' && !u.program) return false;
      if (entityType === 'center' && !u.center) return false;
      if (entityType === 'none' && (u.program || u.center)) return false;

      // Specific program filter
      if (programId != null && u.programId !== programId) return false;

      // Specific center filter
      if (centerId != null && u.centerId !== centerId) return false;

      // Text search filter
      if (!q) return true;
      const fullName = `${u.firstName} ${u.lastName}`.toLowerCase();
      return fullName.includes(q) || u.email.toLowerCase().includes(q);
    });
  });

  /** True when any non-default filter is active — drives the Clear button. */
  readonly hasActiveFilters = computed(
    () =>
      !!this.searchText().trim() ||
      this.linkedEntityFilter() !== null ||
      this.programFilter() !== null ||
      this.centerFilter() !== null,
  );

  /** The selected role in the edit form — drives conditional program/center fields. */
  readonly editingRole = signal<User['role']>(null);

  /** The selected role in the create form — drives conditional program/center fields. */
  readonly creatingRole = signal<User['role']>(null);

  /** The currently authenticated user — used to hide the self-deactivate button. */
  readonly currentUser = this.authService.currentUser;

  // -------------------------------------------------------------------------
  // Role options (shared by edit and create dialogs)
  // -------------------------------------------------------------------------

  readonly roleOptions: RoleOption[] = [
    { label: 'Admin', value: 'admin' },
    { label: 'Workflow Admin', value: 'workflow_admin' },
    { label: 'Unit Admin', value: 'unit_admin' },
    { label: 'Program Rep', value: 'program_rep' },
    { label: 'Center Rep', value: 'center_rep' },
  ];

  /** Options for the "Linked entity" filter Select. */
  readonly linkedEntityOptions: { label: string; value: 'program' | 'center' | 'none' }[] = [
    { label: 'Has linked program', value: 'program' },
    { label: 'Has linked center', value: 'center' },
    { label: 'No linked entity', value: 'none' },
  ];

  // -------------------------------------------------------------------------
  // Forms
  // -------------------------------------------------------------------------

  editForm!: FormGroup;
  createForm!: FormGroup;

  // -------------------------------------------------------------------------
  // Skeleton rows
  // -------------------------------------------------------------------------

  readonly skeletonRows = Array(6).fill(null);

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  ngOnInit(): void {
    this.buildEditForm();
    this.buildCreateForm();
    this.loadUsers();
    // Load reference data for program/center selects
    this.refData.loadPrograms();
    this.refData.loadCenters();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  /** Fetches the full user list from the API. */
  loadUsers(): void {
    this.loading.set(true);
    this.usersService
      .getUsers()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (users) => {
          this.users.set(users);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'Failed to load users. Please try again.',
          });
        },
      });
  }

  // -------------------------------------------------------------------------
  // Form builders
  // -------------------------------------------------------------------------

  /** Builds the reactive form for editing an existing user. */
  private buildEditForm(): void {
    this.editForm = this.fb.group({
      role: [null as User['role']],
      programId: [null as number | null],
      centerId: [null as number | null],
      isActive: [true, Validators.required],
    });

    // Track role changes so template can conditionally show program/center
    this.editForm
      .get('role')!
      .valueChanges.pipe(takeUntil(this.destroy$))
      .subscribe((role) => {
        this.editingRole.set(role);
        // Clear irrelevant linked-entity fields when role changes.
        // workflow_admin (like admin) requires neither a program nor a center.
        if (role !== 'program_rep') this.editForm.patchValue({ programId: null });
        if (role !== 'center_rep') this.editForm.patchValue({ centerId: null });
      });
  }

  /**
   * Builds the reactive form for creating a new pre-provisioned user.
   * Email, firstName, and lastName are required. Role and linked entities
   * are optional at creation time.
   */
  private buildCreateForm(): void {
    this.createForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
      firstName: ['', Validators.required],
      lastName: ['', Validators.required],
      role: [null as User['role']],
      programId: [null as number | null],
      centerId: [null as number | null],
      isActive: [true],
    });

    // Track role changes for conditional program/center fields
    this.createForm
      .get('role')!
      .valueChanges.pipe(takeUntil(this.destroy$))
      .subscribe((role) => {
        this.creatingRole.set(role);
        if (role !== 'program_rep') this.createForm.patchValue({ programId: null });
        if (role !== 'center_rep') this.createForm.patchValue({ centerId: null });
      });
  }

  // -------------------------------------------------------------------------
  // Edit dialog
  // -------------------------------------------------------------------------

  /** Opens the edit dialog pre-populated with the given user's current data. */
  openEditDialog(user: UserWithRelations, tab: number = 0): void {
    this.editingUser.set(user);
    this.editingRole.set(user.role);
    this.editForm.reset({
      role: user.role,
      programId: user.programId,
      centerId: user.centerId,
      isActive: user.isActive,
    });
    this.editDialogActiveTab.set(tab);
    this.dialogVisible.set(true);
  }

  /** Closes the edit dialog and resets state. */
  closeDialog(): void {
    this.dialogVisible.set(false);
    this.editingUser.set(null);
    this.editDialogActiveTab.set(0);
  }

  /** Submits the edit form and updates the user via the API. */
  saveUser(): void {
    if (this.editForm.invalid) return;

    const user = this.editingUser();
    if (!user) return;

    const dto: UpdateUserDto = this.editForm.getRawValue();
    this.saving.set(true);

    this.usersService
      .updateUser(user.id, dto)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (updated) => {
          // Replace the updated user in the list in-place
          this.users.update((list) => list.map((u) => (u.id === updated.id ? updated : u)));
          this.saving.set(false);
          this.closeDialog();
          this.messageService.add({
            severity: 'success',
            summary: 'Saved',
            detail: `${updated.firstName} ${updated.lastName} updated successfully.`,
          });
        },
        error: () => {
          this.saving.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'Failed to save changes. Please try again.',
          });
        },
      });
  }

  // -------------------------------------------------------------------------
  // Create dialog
  // -------------------------------------------------------------------------

  /** Opens the create dialog with a fresh empty form. */
  openCreateDialog(): void {
    this.createForm.reset({
      email: '',
      firstName: '',
      lastName: '',
      role: null,
      programId: null,
      centerId: null,
      isActive: true,
    });
    this.creatingRole.set(null);
    this.showCreateDialog.set(true);
  }

  /** Closes the create dialog and resets state. */
  closeCreateDialog(): void {
    this.showCreateDialog.set(false);
  }

  /**
   * Submits the create form.
   *
   * On 409 (duplicate email): the errorInterceptor already shows a generic
   * error toast for unknown status codes. We additionally set a form-level
   * 'duplicate' error on the email control so the admin sees inline feedback
   * directly on the field. We do NOT add a second toast here.
   *
   * On other errors: the errorInterceptor handles the toast; we just reset
   * the saving state.
   */
  submitCreateUser(): void {
    if (this.createForm.invalid) return;

    const raw = this.createForm.getRawValue();

    // Build the DTO, omitting undefined optional fields
    const dto: CreateUserDto = {
      email: raw.email.trim(),
      firstName: raw.firstName.trim(),
      lastName: raw.lastName.trim(),
    };
    if (raw.role) dto.role = raw.role;
    if (raw.programId) dto.programId = raw.programId;
    if (raw.centerId) dto.centerId = raw.centerId;
    dto.isActive = raw.isActive ?? true;

    this.creating.set(true);

    this.usersService
      .createUser(dto)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (newUser) => {
          // Append the new user to the local list
          this.users.update((list) => [...list, newUser]);
          this.creating.set(false);
          this.closeCreateDialog();
          this.messageService.add({
            severity: 'success',
            summary: 'Created',
            detail: 'User created successfully.',
          });
        },
        error: (err: unknown) => {
          this.creating.set(false);
          // On 409 Conflict (duplicate email) set an inline form error.
          // The errorInterceptor will have already emitted a toast for the
          // generic message — we only add field-level feedback here.
          if (err instanceof HttpErrorResponse && err.status === 409) {
            this.createForm.get('email')!.setErrors({ duplicate: true });
          }
          // All other errors are handled by the global errorInterceptor toast.
        },
      });
  }

  // -------------------------------------------------------------------------
  // Deactivate (soft delete)
  // -------------------------------------------------------------------------

  /**
   * Opens the PrimeNG ConfirmDialog for deactivating a user.
   * On confirmation, calls DELETE /api/users/:id which sets isActive = false.
   * The row is updated in-place rather than removed, so it becomes visible
   * when the "Show inactive" toggle is on.
   */
  confirmDeactivate(user: UserWithRelations): void {
    this.confirmationService.confirm({
      header: 'Deactivate User',
      message: `Deactivate ${user.firstName} ${user.lastName}? They will be hidden from the list and unable to log in, but their history will be preserved.`,
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: 'Deactivate',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => {
        this.usersService
          .deleteUser(user.id)
          .pipe(takeUntil(this.destroy$))
          .subscribe({
            next: () => {
              // Update the row's isActive flag in-place in the signal
              this.users.update((list) =>
                list.map((u) => (u.id === user.id ? { ...u, isActive: false } : u)),
              );
              this.messageService.add({
                severity: 'success',
                summary: 'Deactivated',
                detail: `${user.firstName} ${user.lastName} has been deactivated.`,
              });
            },
            error: (err: unknown) => {
              // 404: user may have already been deleted; refresh the list
              if (err instanceof HttpErrorResponse && err.status === 404) {
                this.loadUsers();
              }
              // errorInterceptor handles the toast for all error statuses
            },
          });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Filters
  // -------------------------------------------------------------------------

  /** Reset every filter back to its default. */
  clearFilters(): void {
    this.searchText.set('');
    this.linkedEntityFilter.set(null);
    this.programFilter.set(null);
    this.centerFilter.set(null);
  }

  // -------------------------------------------------------------------------
  // Template helpers
  // -------------------------------------------------------------------------

  /** Full display name for a user. */
  displayName(user: UserWithRelations): string {
    return `${user.firstName} ${user.lastName}`.trim();
  }

  /** PrimeNG Tag severity for a given role. */
  roleSeverity(role: User['role']): 'contrast' | 'info' | 'warn' | 'secondary' | 'danger' {
    switch (role) {
      case 'admin':
        // Slate / charcoal — high contrast, highest permission level
        return 'contrast';
      case 'workflow_admin':
        // Amber/warning tone — distinguishes from admin and program_rep
        return 'warn';
      case 'unit_admin':
        // Teal / success severity — distinct from all others.
        // PrimeNG doesn't expose a teal preset, so we reuse 'success'
        // (green) which is not used by any other role, making it visually
        // distinct. A CSS override in user-list.component.scss provides
        // the actual teal color.
        return 'info'; // overridden via CSS to teal below
      case 'program_rep':
        return 'info';
      case 'center_rep':
        return 'danger';
      default:
        return 'secondary';
    }
  }

  /**
   * CSS class appended to the p-tag for the unit_admin row so we can
   * override the color independently from program_rep (both use 'info' severity).
   */
  roleTagClass(role: User['role']): string {
    return role === 'unit_admin' ? 'role-tag--unit-admin' : '';
  }

  /** Human-readable label for a role. */
  roleLabel(role: User['role']): string {
    switch (role) {
      case 'admin':
        return 'Admin';
      case 'workflow_admin':
        return 'Workflow Admin';
      case 'unit_admin':
        return 'Unit Admin';
      case 'program_rep':
        return 'Program Rep';
      case 'center_rep':
        return 'Center Rep';
      default:
        return 'Unassigned';
    }
  }

  /**
   * Hardcoded ON until a proper staging environment lands (see todo.md #10).
   * Before that, this was gated on `!environment.production`, but the
   * deployed dev server uses the production build, which hid the button.
   */
  readonly isDev = true;

  /**
   * Opens the dev-login URL for the given user, bypassing Cognito.
   * Uses window.location.href (full page) so the auth-callback route
   * can exchange the dev token server-side and establish the session.
   * Dev-only — server also rejects this endpoint in production.
   */
  loginAs(user: UserWithRelations): void {
    const url = `/auth?dev=${encodeURIComponent(user.email)}`;
    window.location.href = url;
  }

  /** Linked entity display string for the table cell. */
  linkedEntity(user: UserWithRelations): string {
    if (user.program) return `${user.program.officialCode} — ${user.program.name}`;
    if (user.center) return `${user.center.acronym} — ${user.center.name}`;
    return '—';
  }
}
