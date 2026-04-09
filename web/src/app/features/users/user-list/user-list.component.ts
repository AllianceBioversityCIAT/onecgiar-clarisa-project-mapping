import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  FormsModule,
  Validators,
} from '@angular/forms';
import { Subject, debounceTime, distinctUntilChanged, takeUntil } from 'rxjs';

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
import { MessageService } from 'primeng/api';

import { UsersService } from '../services/users.service';
import { ReferenceDataService } from '../../../core/services/reference-data.service';
import { UserWithRelations, UpdateUserDto } from '../models/user-management.model';
import { User } from '../../../core/models/user.model';

/** Role option for the edit-dialog Select. */
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
 *  - Edit dialog with role, linked program/center, and active-status controls
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
  ],
  providers: [MessageService],
  templateUrl: './user-list.component.html',
  styleUrl: './user-list.component.scss',
})
export class UserListComponent implements OnInit, OnDestroy {
  private readonly usersService = inject(UsersService);
  private readonly refData = inject(ReferenceDataService);
  private readonly fb = inject(FormBuilder);
  private readonly messageService = inject(MessageService);
  private readonly destroy$ = new Subject<void>();

  // -------------------------------------------------------------------------
  // State signals
  // -------------------------------------------------------------------------

  /** Full user list from API. */
  readonly users = signal<UserWithRelations[]>([]);

  /** True while the initial list fetch is in progress. */
  readonly loading = signal(true);

  /** True while an edit save is being submitted. */
  readonly saving = signal(false);

  /** Controls edit-dialog visibility. */
  readonly dialogVisible = signal(false);

  /** The user currently being edited (null = dialog closed). */
  readonly editingUser = signal<UserWithRelations | null>(null);

  /** Client-side search string. */
  readonly searchText = signal('');

  // -------------------------------------------------------------------------
  // Computed
  // -------------------------------------------------------------------------

  /** Programs list from reference data for the Select. */
  readonly programs = this.refData.programs;

  /** Centers list from reference data for the Select. */
  readonly centers = this.refData.centers;

  /** Filtered user list based on searchText. */
  readonly filteredUsers = computed(() => {
    const q = this.searchText().toLowerCase().trim();
    if (!q) return this.users();
    return this.users().filter(u => {
      const fullName = `${u.firstName} ${u.lastName}`.toLowerCase();
      return fullName.includes(q) || u.email.toLowerCase().includes(q);
    });
  });

  /** The selected role value from the edit form — drives conditional fields. */
  readonly editingRole = signal<User['role']>(null);

  // -------------------------------------------------------------------------
  // Role options
  // -------------------------------------------------------------------------

  readonly roleOptions: RoleOption[] = [
    { label: 'Admin', value: 'admin' },
    { label: 'Program Rep', value: 'program_rep' },
    { label: 'Center Rep', value: 'center_rep' },
  ];

  // -------------------------------------------------------------------------
  // Edit form
  // -------------------------------------------------------------------------

  editForm!: FormGroup;

  // -------------------------------------------------------------------------
  // Skeleton rows
  // -------------------------------------------------------------------------

  readonly skeletonRows = Array(6).fill(null);

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  ngOnInit(): void {
    this.buildForm();
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

  /** Fetches the user list from the API. */
  loadUsers(): void {
    this.loading.set(true);
    this.usersService.getUsers()
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: users => {
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
  // Form builder
  // -------------------------------------------------------------------------

  private buildForm(): void {
    this.editForm = this.fb.group({
      role:      [null as User['role']],
      programId: [null as string | null],
      centerId:  [null as string | null],
      isActive:  [true, Validators.required],
    });

    // Track role changes so template can conditionally show program/center
    this.editForm.get('role')!.valueChanges
      .pipe(takeUntil(this.destroy$))
      .subscribe(role => {
        this.editingRole.set(role);
        // Clear irrelevant linked-entity fields when role changes
        if (role !== 'program_rep') this.editForm.patchValue({ programId: null });
        if (role !== 'center_rep')  this.editForm.patchValue({ centerId: null });
      });
  }

  // -------------------------------------------------------------------------
  // Edit dialog
  // -------------------------------------------------------------------------

  /** Opens the edit dialog pre-populated with the given user's current data. */
  openEditDialog(user: UserWithRelations): void {
    this.editingUser.set(user);
    this.editingRole.set(user.role);
    this.editForm.reset({
      role:      user.role,
      programId: user.programId,
      centerId:  user.centerId,
      isActive:  user.isActive,
    });
    this.dialogVisible.set(true);
  }

  /** Closes the edit dialog and resets state. */
  closeDialog(): void {
    this.dialogVisible.set(false);
    this.editingUser.set(null);
  }

  /** Submits the edit form and updates the user via the API. */
  saveUser(): void {
    if (this.editForm.invalid) return;

    const user = this.editingUser();
    if (!user) return;

    const dto: UpdateUserDto = this.editForm.getRawValue();
    this.saving.set(true);

    this.usersService.updateUser(user.id, dto)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: updated => {
          // Replace the updated user in the list in-place
          this.users.update(list =>
            list.map(u => (u.id === updated.id ? updated : u)),
          );
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
  // Template helpers
  // -------------------------------------------------------------------------

  /** Full display name for a user. */
  displayName(user: UserWithRelations): string {
    return `${user.firstName} ${user.lastName}`.trim();
  }

  /** PrimeNG Tag severity for a given role. */
  roleSeverity(role: User['role']): 'contrast' | 'info' | 'warn' | 'secondary' {
    switch (role) {
      case 'admin':       return 'contrast';
      case 'program_rep': return 'info';
      case 'center_rep':  return 'warn';
      default:            return 'secondary';
    }
  }

  /** Human-readable label for a role. */
  roleLabel(role: User['role']): string {
    switch (role) {
      case 'admin':       return 'Admin';
      case 'program_rep': return 'Program Rep';
      case 'center_rep':  return 'Center Rep';
      default:            return 'Unassigned';
    }
  }

  /** Linked entity display string for the table cell. */
  linkedEntity(user: UserWithRelations): string {
    if (user.program) return `${user.program.officialCode} — ${user.program.name}`;
    if (user.center)  return `${user.center.acronym} — ${user.center.name}`;
    return '—';
  }
}
