import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, Subscription, debounceTime, distinctUntilChanged } from 'rxjs';

import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { SkeletonModule } from 'primeng/skeleton';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';
import { TooltipModule } from 'primeng/tooltip';

import { EmailsService } from '../emails.service';
import { EmailListItem, EmailStatus } from '../models/email.model';
import { UsersService } from '../../../users/services/users.service';
import { UserWithRelations } from '../../../users/models/user-management.model';

/** Status badge severity mapping for PrimeNG p-tag. */
const STATUS_SEVERITY: Record<EmailStatus, 'info' | 'warn' | 'success' | 'danger'> = {
  queued: 'info',
  sending: 'warn',
  sent: 'success',
  failed: 'danger',
};

/** Human-readable labels for each status value. */
const STATUS_LABELS: Record<EmailStatus, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
};

/** Options for the status multi-select filter. */
const STATUS_OPTIONS = (Object.keys(STATUS_LABELS) as EmailStatus[]).map((s) => ({
  label: STATUS_LABELS[s],
  value: s,
}));

/** Option shape used in the recipient p-select. */
interface UserOption {
  label: string;
  value: number;
}

/**
 * EmailsListComponent — /admin/emails
 *
 * Displays a server-side paginated, filterable table of every email in
 * the outbox. Filters react immediately (with a 300 ms debounce on the
 * free-text input). The retry action uses ConfirmationService so the user
 * must confirm before the API call is made.
 */
@Component({
  selector: 'app-emails-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    TableModule,
    TagModule,
    ButtonModule,
    ToastModule,
    SelectModule,
    MultiSelectModule,
    DatePickerModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    SkeletonModule,
    ConfirmDialogModule,
    TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './emails-list.component.html',
  styleUrl: './emails-list.component.scss',
})
export class EmailsListComponent implements OnInit, OnDestroy {
  // ---------------------------------------------------------------------------
  // DI
  // ---------------------------------------------------------------------------

  private readonly emailsService = inject(EmailsService);
  private readonly usersService = inject(UsersService);
  private readonly messageService = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly router = inject(Router);

  // ---------------------------------------------------------------------------
  // Table state
  // ---------------------------------------------------------------------------

  readonly emails = signal<EmailListItem[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly retryingId = signal<number | null>(null);

  /** Count of emails currently in 'queued' status — drives the purge button label and disabled state. */
  readonly queuedCount = signal(0);

  /** True while the DELETE /admin/emails/queued request is in flight. */
  readonly purging = signal(false);

  /** True while the POST /admin/emails/run-reminders request is in flight. */
  readonly runningReminders = signal(false);

  /** Current pagination state — kept in sync with the lazy-load event. */
  private currentPage = 1;
  private currentPageSize = 25;
  private currentSortBy: 'queued_at' | 'sent_at' | 'status' | 'attempts' = 'queued_at';
  private currentSortDir: 'ASC' | 'DESC' = 'DESC';

  // ---------------------------------------------------------------------------
  // Filter state (signals so the template can read them reactively)
  // ---------------------------------------------------------------------------

  /** Free-text search bound to the input field. */
  readonly searchText = signal('');

  /** Selected status values from the multi-select. */
  readonly selectedStatuses = signal<EmailStatus[]>([]);

  /** Selected recipient user ID from the p-select. */
  readonly selectedUserId = signal<number | null>(null);

  /**
   * Date range from p-datepicker selectionMode="range".
   * PrimeNG writes [from: Date | null, to: Date | null].
   */
  readonly dateRange = signal<(Date | null)[]>([null, null]);

  // ---------------------------------------------------------------------------
  // Filter option lists (static + async)
  // ---------------------------------------------------------------------------

  readonly statusOptions = STATUS_OPTIONS;

  /** User list for the recipient dropdown — loaded once on init. */
  readonly userOptions = signal<UserOption[]>([]);

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  /** True when any filter control has a non-default value. */
  readonly hasActiveFilters = computed(() => {
    const [from, to] = this.dateRange();
    return (
      this.searchText().trim() !== '' ||
      this.selectedStatuses().length > 0 ||
      this.selectedUserId() !== null ||
      from !== null ||
      to !== null
    );
  });

  // ---------------------------------------------------------------------------
  // Search debounce
  // ---------------------------------------------------------------------------

  private readonly searchSubject = new Subject<string>();
  private readonly subscriptions = new Subscription();

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ngOnInit(): void {
    // Debounce the free-text search: fire a reload 300 ms after the user stops
    // typing to avoid an API call on every keystroke.
    this.subscriptions.add(
      this.searchSubject.pipe(debounceTime(300), distinctUntilChanged()).subscribe(() => {
        this.currentPage = 1;
        this.loadEmails();
      }),
    );

    // Populate the recipient dropdown from the users endpoint.
    this.loadUserOptions();

    // Load the queued count for the purge button.
    this.loadQueuedCount();
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  /**
   * Fetches one page of emails from the API using the current filter and
   * pagination state. Called by the PrimeNG lazy-load event and by every
   * filter-change handler.
   */
  loadEmails(): void {
    this.loading.set(true);

    const [from, to] = this.dateRange();

    // Build end-of-day ISO string for dateTo so the range is inclusive.
    let dateTo: string | undefined;
    if (to) {
      const eod = new Date(to);
      eod.setHours(23, 59, 59, 999);
      dateTo = eod.toISOString();
    }

    this.emailsService
      .list({
        page: this.currentPage,
        limit: this.currentPageSize,
        sortBy: this.currentSortBy,
        sortDir: this.currentSortDir,
        status: this.selectedStatuses().length > 0 ? this.selectedStatuses().join(',') : undefined,
        toUserId: this.selectedUserId() ?? undefined,
        search: this.searchText().trim() || undefined,
        dateFrom: from ? from.toISOString() : undefined,
        dateTo,
      })
      .subscribe({
        next: (res) => {
          this.emails.set(res.data);
          this.total.set(res.total);
          this.loading.set(false);
          // Keep the purge-button count in sync after every list refresh.
          this.loadQueuedCount();
        },
        error: () => {
          this.loading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Failed to load emails',
            detail: 'Could not retrieve email list. Please try again.',
            life: 6000,
          });
        },
      });
  }

  /**
   * Fetches the full user list to populate the recipient dropdown.
   * Non-fatal: if the request fails the dropdown stays empty but the page
   * still works.
   */
  private loadUserOptions(): void {
    this.usersService.getUsers().subscribe({
      next: (users: UserWithRelations[]) => {
        this.userOptions.set(
          users.map((u) => ({
            label: `${u.firstName} ${u.lastName}`.trim() || u.email,
            value: u.id,
          })),
        );
      },
      error: () => {
        // Non-fatal: dropdown stays empty; user can still filter by status / search.
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Queued count (drives purge button label + disabled state)
  // ---------------------------------------------------------------------------

  /**
   * Fires a cheap GET /admin/emails?status=queued&limit=1 and stores the
   * `total` from the paginated envelope into queuedCount. Called on init
   * and after every list reload so the button label stays accurate.
   * Non-fatal: if the request fails the count stays at its last known value.
   */
  private loadQueuedCount(): void {
    this.emailsService.list({ status: 'queued', limit: 1, page: 1 }).subscribe({
      next: (res) => this.queuedCount.set(res.total),
      error: () => {
        // Non-fatal — the purge button remains operable; it just shows a
        // potentially stale count. The backend handles 0-row purges gracefully.
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Purge queued action
  // ---------------------------------------------------------------------------

  /**
   * Opens a ConfirmationService dialog before purging. Mirrors the retry
   * pattern used above: confirm first, then execute.
   */
  confirmPurge(): void {
    const count = this.queuedCount();
    this.confirmationService.confirm({
      header: 'Purge queued emails?',
      message: `Permanently delete all ${count} queued email${count !== 1 ? 's' : ''}? This cannot be undone. Rows being sent, already sent, or failed are not affected.`,
      icon: 'pi pi-trash',
      acceptLabel: 'Delete',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.executePurge(),
    });
  }

  private executePurge(): void {
    this.purging.set(true);
    this.emailsService.purgeQueued().subscribe({
      next: (res) => {
        this.purging.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Purged',
          detail: `Deleted ${res.deleted} queued email${res.deleted !== 1 ? 's' : ''}.`,
          life: 5000,
        });
        // Reload the list and refresh the count so the UI reflects the deletion.
        this.loadEmails();
      },
      error: (err: unknown) => {
        this.purging.set(false);
        console.warn('[EmailsListComponent] Purge queued failed', err);
        this.messageService.add({
          severity: 'error',
          summary: 'Purge failed',
          detail: this.extractErrorMessage(err),
          life: 8000,
        });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Run reminders now action
  // ---------------------------------------------------------------------------

  /**
   * Opens a ConfirmationService dialog before manually running the
   * mapping-reminder generation. Mirrors the purge/retry pattern: confirm
   * first, then execute.
   */
  confirmRunReminders(): void {
    this.confirmationService.confirm({
      header: 'Run mapping reminders now?',
      message:
        'Generate mapping-progress reminder emails now, bypassing the weekly (Monday) schedule. ' +
        'Centers already at the target, with no portfolio, or with no reps are skipped, and anyone ' +
        'already reminded today will not be emailed again. Queued reminders are sent on the next ' +
        'dispatch run (subject to the global email toggle).',
      icon: 'pi pi-send',
      acceptLabel: 'Run now',
      rejectLabel: 'Cancel',
      accept: () => this.executeRunReminders(),
    });
  }

  private executeRunReminders(): void {
    this.runningReminders.set(true);
    this.emailsService.runReminders().subscribe({
      next: (res) => {
        this.runningReminders.set(false);
        // Map the run outcome to a toast severity:
        //  - rows queued       → success
        //  - tick errored      → warn (nothing queued, but it wasn't a clean no-op)
        //  - benign no-op       → info (e.g. deadline not set, all centers at target)
        let severity: 'success' | 'info' | 'warn' = 'info';
        let summary = 'No reminders queued';
        if (res.enqueued > 0) {
          severity = 'success';
          summary = 'Reminders queued';
        } else if (res.shortCircuit === 'error') {
          severity = 'warn';
          summary = 'Reminder run incomplete';
        }
        this.messageService.add({ severity, summary, detail: res.message, life: 7000 });
        // New reminder rows land as 'queued' — refresh the list + count.
        this.loadEmails();
      },
      error: (err: unknown) => {
        this.runningReminders.set(false);
        console.warn('[EmailsListComponent] Run reminders failed', err);
        this.messageService.add({
          severity: 'error',
          summary: 'Reminder run failed',
          detail: this.extractErrorMessage(err),
          life: 8000,
        });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // PrimeNG table event
  // ---------------------------------------------------------------------------

  /**
   * PrimeNG fires (onLazyLoad) on every page/sort change.
   * `first` is zero-based; convert to 1-based page number.
   */
  onLazyLoad(event: TableLazyLoadEvent): void {
    const first = event.first ?? 0;
    const rows = event.rows ?? 25;
    this.currentPage = Math.floor(first / rows) + 1;
    this.currentPageSize = rows;

    // Map PrimeNG sortField → API sortBy whitelist
    const sortField = Array.isArray(event.sortField) ? event.sortField[0] : event.sortField;
    const sortMap: Record<string, 'queued_at' | 'sent_at' | 'status' | 'attempts'> = {
      queuedAt: 'queued_at',
      sentAt: 'sent_at',
      status: 'status',
      attempts: 'attempts',
    };
    if (sortField && sortMap[sortField]) {
      this.currentSortBy = sortMap[sortField];
    }
    if (event.sortOrder === 1) this.currentSortDir = 'ASC';
    if (event.sortOrder === -1) this.currentSortDir = 'DESC';

    this.loadEmails();
  }

  // ---------------------------------------------------------------------------
  // Filter event handlers
  // ---------------------------------------------------------------------------

  /** Called on each keystroke — feeds the 300 ms debounce subject. */
  onSearchInput(value: string): void {
    this.searchText.set(value);
    this.searchSubject.next(value);
  }

  /** Called when any dropdown/multi-select filter changes. Resets to page 1. */
  onFilterChange(): void {
    this.currentPage = 1;
    this.loadEmails();
  }

  /**
   * Called when the date range picker emits a new value.
   * Only fires a reload once both ends are selected (or both cleared) to
   * avoid triggering a request after only the start date is chosen.
   */
  onDateRangeChange(range: (Date | null)[]): void {
    this.dateRange.set(range);
    const [from, to] = range;
    const bothPicked = (from !== null && to !== null) || (from === null && to === null);
    if (bothPicked) {
      this.currentPage = 1;
      this.loadEmails();
    }
  }

  /**
   * Re-fetches the current page with current filters intact.
   * Bound to the toolbar Refresh button.
   */
  refresh(): void {
    this.loadEmails();
  }

  /** Resets all filter controls to their default values and reloads. */
  clearFilters(): void {
    this.searchText.set('');
    this.selectedStatuses.set([]);
    this.selectedUserId.set(null);
    this.dateRange.set([null, null]);
    this.currentPage = 1;
    this.loadEmails();
  }

  // ---------------------------------------------------------------------------
  // Retry action
  // ---------------------------------------------------------------------------

  /**
   * Opens a PrimeNG confirm dialog before calling the retry endpoint.
   * On confirmation: calls POST /admin/emails/:id/retry, shows a success
   * toast, and reloads the current page.
   * On 400 with EMAIL_NOT_RETRIABLE: surfaces the backend message.
   * On other errors: shows a generic error toast.
   */
  confirmRetry(email: EmailListItem): void {
    this.confirmationService.confirm({
      header: 'Retry email?',
      message:
        'Reset this email to queued so it will be retried by the next worker run. The attempts counter will NOT reset.',
      icon: 'pi pi-refresh',
      acceptLabel: 'Retry',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-warning',
      accept: () => this.executeRetry(email.id),
    });
  }

  private executeRetry(id: number): void {
    this.retryingId.set(id);
    this.emailsService.retry(id).subscribe({
      next: () => {
        this.retryingId.set(null);
        this.messageService.add({
          severity: 'success',
          summary: 'Email reset to queued',
          detail: 'The email will be retried on the next worker run.',
          life: 4000,
        });
        this.loadEmails();
      },
      error: (err: unknown) => {
        this.retryingId.set(null);
        const detail = this.extractErrorMessage(err);
        this.messageService.add({
          severity: 'error',
          summary: 'Retry failed',
          detail,
          life: 8000,
        });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Display helpers
  // ---------------------------------------------------------------------------

  /** Returns the PrimeNG tag severity for a given email status. */
  statusSeverity(status: EmailStatus): 'info' | 'warn' | 'success' | 'danger' {
    return STATUS_SEVERITY[status] ?? 'info';
  }

  /** Returns the human-readable label for a given email status. */
  statusLabel(status: EmailStatus): string {
    return STATUS_LABELS[status] ?? status;
  }

  /**
   * Returns the display name for the recipient.
   * Shows the user's name if available, falling back to the raw email address.
   */
  recipientLabel(email: EmailListItem): string {
    return email.toUserName?.trim() || email.toEmail;
  }

  /**
   * Formats an ISO timestamp string as a short human-readable date/time.
   * e.g. "17 May 2026, 14:32"
   */
  formatDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Extracts a human-readable error message from an HTTP error or generic
   * Error object. Surfaces the backend's validation message verbatim when
   * the code is EMAIL_NOT_RETRIABLE; falls back to a generic string.
   */
  private extractErrorMessage(err: unknown): string {
    if (err && typeof err === 'object') {
      const httpErr = err as { error?: { message?: string | string[]; code?: string } };
      if (httpErr.error?.message) {
        const msg = httpErr.error.message;
        return Array.isArray(msg) ? msg.join(' ') : msg;
      }
    }
    return 'An unexpected error occurred. Please try again.';
  }

  /** Navigates to the detail page for the given email. */
  viewDetail(id: number): void {
    void this.router.navigate(['/admin/emails', id]);
  }
}
