import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule, DatePipe, TitleCasePipe } from '@angular/common';
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
import { TagModule } from 'primeng/tag';
import { ProgressBarModule } from 'primeng/progressbar';
import { DialogModule } from 'primeng/dialog';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { TextareaModule } from 'primeng/textarea';
import { ToastModule } from 'primeng/toast';
import { DividerModule } from 'primeng/divider';
import { SkeletonModule } from 'primeng/skeleton';
import { TableModule } from 'primeng/table';
import { ConfirmationService, MessageService } from 'primeng/api';

import { MappingsService } from '../services/mappings.service';
import { AuthService } from '../../../core/services/auth.service';
import { Mapping, AllocationSummary } from '../models/mapping.model';

/**
 * MappingReviewComponent — read-only detail view of a single mapping with
 * approve/reject workflow for center_rep users.
 *
 * Route: /mappings/:id/review  (center_rep and admin, protected by roleGuard)
 *
 * Sections:
 *  - Project info panel (read-only): name, code, center
 *  - Mapping details: program, allocation %, ratings, submitted by
 *  - Overall allocation summary: ProgressBar + per-program breakdown table
 *  - Action buttons (pending only, center_rep only):
 *      Approve → ConfirmDialog before calling API
 *      Reject  → Dialog with required Textarea (min 10 chars)
 *  - If already reviewed: shows read-only status + reason; hides action buttons
 */
@Component({
  selector: 'app-mapping-review',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    CardModule,
    ButtonModule,
    TagModule,
    ProgressBarModule,
    DialogModule,
    ConfirmDialogModule,
    TextareaModule,
    ToastModule,
    DividerModule,
    SkeletonModule,
    TableModule,
  ],
  providers: [ConfirmationService, MessageService, DatePipe, TitleCasePipe],
  templateUrl: './mapping-review.component.html',
  styleUrl: './mapping-review.component.scss',
})
export class MappingReviewComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly fb = inject(FormBuilder);
  private readonly mappingsService = inject(MappingsService);
  private readonly authService = inject(AuthService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly messageService = inject(MessageService);

  // -----------------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------------

  readonly isCenterRep = this.authService.isCenterRep;
  readonly isAdmin = this.authService.isAdmin;

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------

  /** The loaded mapping, or null while loading / on error. */
  readonly mapping = signal<Mapping | null>(null);

  /** Allocation summary for the mapping's project. */
  readonly allocationSummary = signal<AllocationSummary | null>(null);

  /** True while the initial mapping fetch is in flight. */
  readonly loading = signal(true);

  /** True when the API returned an error or the mapping is not found. */
  readonly error = signal(false);

  /** True while an approve/reject API call is in flight. */
  readonly actionLoading = signal(false);

  /** Controls the reject reason dialog visibility. */
  readonly rejectDialogVisible = signal(false);

  // -----------------------------------------------------------------------
  // Derived
  // -----------------------------------------------------------------------

  /** True when this mapping can still be reviewed (status is pending). */
  readonly isPending = computed(() => this.mapping()?.status === 'pending');

  /** True when the current user can perform approval actions. */
  readonly canReview = computed(() => this.isCenterRep() && this.isPending());

  /** Status tag severity. */
  readonly statusSeverity = computed<'info' | 'success' | 'danger'>(() => {
    const map: Record<string, 'info' | 'success' | 'danger'> = {
      pending:  'info',
      approved: 'success',
      rejected: 'danger',
    };
    return map[this.mapping()?.status ?? ''] ?? 'info';
  });

  /** Rating badge CSS class segment. */
  getRatingClass(rating: string | null): string {
    return rating ? `rating-badge--${rating}` : 'rating-badge--none';
  }

  /** Humanises a rating value. */
  getRatingLabel(rating: string | null): string {
    if (!rating) return '—';
    return rating.charAt(0).toUpperCase() + rating.slice(1);
  }

  // -----------------------------------------------------------------------
  // Reject form
  // -----------------------------------------------------------------------

  /**
   * Reactive form for the reject reason dialog.
   * reason is required and must be at least 10 characters.
   */
  readonly rejectForm: FormGroup = this.fb.group({
    reason: ['', [Validators.required, Validators.minLength(10)]],
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngOnInit(): void {
    const raw = this.route.snapshot.paramMap.get('id');
    if (!raw) {
      this.router.navigate(['/mappings']);
      return;
    }
    // Route params are always strings — coerce to integer before service calls.
    this.loadMapping(Number(raw));
  }

  // -----------------------------------------------------------------------
  // Data loading
  // -----------------------------------------------------------------------

  private loadMapping(id: number): void {
    this.loading.set(true);
    this.error.set(false);

    this.mappingsService.getMapping(id).subscribe({
      next: async mapping => {
        this.mapping.set(mapping);
        this.loading.set(false);
        // Load allocation summary for the project in parallel.
        try {
          const summary = await firstValueFrom(
            this.mappingsService.getAllocationSummary(mapping.project.id),
          );
          this.allocationSummary.set(summary);
        } catch {
          // Summary is non-critical; continue without it.
        }
      },
      error: () => {
        this.error.set(true);
        this.loading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Not Found',
          detail: 'Mapping could not be loaded.',
        });
      },
    });
  }

  // -----------------------------------------------------------------------
  // Approve workflow
  // -----------------------------------------------------------------------

  /**
   * Shows a PrimeNG ConfirmDialog before calling the approve endpoint.
   */
  openApproveDialog(): void {
    const m = this.mapping();
    if (!m) return;

    this.confirmationService.confirm({
      header: 'Approve Mapping',
      message: `Approve the mapping from ${m.program.name} to "${m.project.name}"?`,
      icon: 'pi pi-check-circle',
      acceptLabel: 'Approve',
      rejectLabel: 'Cancel',
      accept: () => this.doApprove(m.id),
    });
  }

  private doApprove(id: number): void {
    this.actionLoading.set(true);
    this.mappingsService.approveMapping(id).subscribe({
      next: updated => {
        this.mapping.set(updated);
        this.actionLoading.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Approved',
          detail: 'Mapping approved successfully.',
        });
        setTimeout(() => this.router.navigate(['/mappings']), 1500);
      },
      error: () => {
        this.actionLoading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'Failed to approve mapping.',
        });
      },
    });
  }

  // -----------------------------------------------------------------------
  // Reject workflow
  // -----------------------------------------------------------------------

  /** Opens the reject reason dialog. */
  openRejectDialog(): void {
    this.rejectForm.reset();
    this.rejectDialogVisible.set(true);
  }

  /** Closes the reject reason dialog without submitting. */
  closeRejectDialog(): void {
    this.rejectDialogVisible.set(false);
  }

  /** Submits the rejection with the provided reason. */
  submitRejection(): void {
    this.rejectForm.markAllAsTouched();
    if (this.rejectForm.invalid) return;

    const id = this.mapping()?.id;
    if (!id) return;

    const reason = this.rejectForm.get('reason')?.value?.trim();
    this.actionLoading.set(true);
    this.rejectDialogVisible.set(false);

    this.mappingsService.rejectMapping(id, reason).subscribe({
      next: updated => {
        this.mapping.set(updated);
        this.actionLoading.set(false);
        this.messageService.add({
          severity: 'warn',
          summary: 'Rejected',
          detail: 'Mapping rejected.',
        });
        setTimeout(() => this.router.navigate(['/mappings']), 1500);
      },
      error: () => {
        this.actionLoading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'Failed to reject mapping.',
        });
      },
    });
  }

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  goBack(): void {
    this.router.navigate(['/mappings']);
  }

  // -----------------------------------------------------------------------
  // Allocation summary helpers
  // -----------------------------------------------------------------------

  /** Severity for the per-program status tags in the summary table. */
  getAllocationStatusSeverity(status: string): 'info' | 'success' | 'danger' {
    const map: Record<string, 'info' | 'success' | 'danger'> = {
      pending:  'info',
      approved: 'success',
      rejected: 'danger',
    };
    return map[status] ?? 'info';
  }
}
