import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subject, Subscription, debounceTime, distinctUntilChanged } from 'rxjs';

import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { DrawerModule } from 'primeng/drawer';
import { DividerModule } from 'primeng/divider';
import { MessageService } from 'primeng/api';

import { AuditLogService } from './audit-log.service';
import { AuditEvent, AuditLogQueryFilters } from './audit-event.model';
import {
  actionLabel as auditActionLabel,
  formatAuditTimestamp,
  formatAuditValue,
  fieldLabel as auditFieldLabel,
  roleLabel as auditRoleLabel,
  entityIcon as auditEntityIcon,
  entityTypeLabel as auditEntityTypeLabel,
} from './audit-log.utils';

/** Chars before truncation in table cells. */
const TRUNCATE_LENGTH = 80;

// ---------------------------------------------------------------------------
// Entity type options (for filter dropdown)
// ---------------------------------------------------------------------------

interface SelectOption {
  label: string;
  value: string;
}

const ENTITY_TYPE_OPTIONS: SelectOption[] = [
  { label: 'Project', value: 'project' },
  { label: 'Mapping', value: 'project_mapping' },
  { label: 'User', value: 'user' },
  { label: 'Snapshot', value: 'published_snapshot' },
  { label: 'Import run', value: 'import_run' },
  { label: 'CLARISA sync', value: 'clarisa_sync' },
  { label: 'System', value: 'system' },
];

const ACTOR_ROLE_OPTIONS: SelectOption[] = [
  { label: 'Admin', value: 'admin' },
  { label: 'Workflow Admin', value: 'workflow_admin' },
  { label: 'Unit Admin', value: 'unit_admin' },
  { label: 'Center Rep', value: 'center_rep' },
  { label: 'Program Rep', value: 'program_rep' },
  { label: 'System', value: 'system' },
];

// ---------------------------------------------------------------------------
// Diff row model for the drawer table
// ---------------------------------------------------------------------------

interface DiffRow {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * AuditLogComponent — the /admin/audit-log page.
 *
 * Displays a filterable, server-side paginated table of every audit event
 * in the system. Clicking "View" on any row opens a right-hand side panel
 * that shows the full event detail including the before/after field diff.
 *
 * Filter state is synced to/from URL query params for deep-linking.
 * The free-text search input is debounced (250 ms) to avoid excessive API calls.
 *
 * Role-gated: only admin / workflow_admin / unit_admin can reach this page.
 * The route guard in app.routes.ts handles unauthorised access.
 */
@Component({
  selector: 'app-audit-log',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    TableModule,
    TagModule,
    TooltipModule,
    ToastModule,
    ButtonModule,
    SelectModule,
    DatePickerModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    DrawerModule,
    DividerModule,
  ],
  providers: [MessageService],
  templateUrl: './audit-log.component.html',
  styleUrl: './audit-log.component.scss',
})
export class AuditLogComponent implements OnInit, OnDestroy {
  // -------------------------------------------------------------------------
  // DI
  // -------------------------------------------------------------------------

  private readonly auditLogService = inject(AuditLogService);
  private readonly messageService = inject(MessageService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  // -------------------------------------------------------------------------
  // Filter state
  // -------------------------------------------------------------------------

  /** Free-text search string bound to the input. Updated on each keystroke. */
  readonly searchText = signal('');

  /** Selected entity-type filter value. */
  readonly selectedEntityType = signal<string | null>(null);

  /** Selected actor-role filter value. */
  readonly selectedActorRole = signal<string | null>(null);

  /** Selected action filter value. */
  readonly selectedAction = signal<string | null>(null);

  /**
   * Date range selection.
   * PrimeNG DatePicker with selectionMode="range" writes [from, to | null].
   */
  readonly dateRange = signal<(Date | null)[]>([null, null]);

  // -------------------------------------------------------------------------
  // Table state
  // -------------------------------------------------------------------------

  readonly events = signal<AuditEvent[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);

  /** Current page (1-based). Tracked so URL sync works correctly. */
  private currentPage = 1;
  private currentPageSize = 50;

  /**
   * Current sort state. Drives both the API request and the table's visual
   * sort indicators. The backend whitelist is `created_at | actor_user_id |
   * action`; the frontend column field names are mapped to those keys in
   * loadPage(). PrimeNG's sortOrder uses 1=asc, -1=desc.
   */
  currentSortField = 'createdAt';
  currentSortOrder: 1 | -1 = -1;

  // -------------------------------------------------------------------------
  // Drawer (side panel) state
  // -------------------------------------------------------------------------

  readonly drawerOpen = signal(false);
  readonly selectedEvent = signal<AuditEvent | null>(null);
  readonly drawerLoading = signal(false);

  /** Diff rows derived from the selected event's `changes` map. */
  readonly diffRows = computed<DiffRow[]>(() => {
    const ev = this.selectedEvent();
    if (!ev?.changes) return [];
    return Object.entries(ev.changes).map(([field, { before, after }]) => ({
      field,
      before,
      after,
    }));
  });

  // -------------------------------------------------------------------------
  // Action options (loaded from API)
  // -------------------------------------------------------------------------

  readonly actionOptions = signal<SelectOption[]>([]);

  // -------------------------------------------------------------------------
  // Static option lists for dropdowns
  // -------------------------------------------------------------------------

  readonly entityTypeOptions = ENTITY_TYPE_OPTIONS;
  readonly actorRoleOptions = ACTOR_ROLE_OPTIONS;

  // -------------------------------------------------------------------------
  // Search debounce
  // -------------------------------------------------------------------------

  private readonly searchSubject = new Subject<string>();
  private readonly subscriptions = new Subscription();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  ngOnInit(): void {
    // Load available action strings for the action filter dropdown.
    this.loadActions();

    // Read initial filter state from URL query params.
    const qp = this.route.snapshot.queryParams;
    if (qp['search']) this.searchText.set(qp['search']);
    if (qp['entityType']) this.selectedEntityType.set(qp['entityType']);
    if (qp['actorRole']) this.selectedActorRole.set(qp['actorRole']);
    if (qp['action']) this.selectedAction.set(qp['action']);
    if (qp['from'] || qp['to']) {
      const from = qp['from'] ? new Date(qp['from']) : null;
      const to = qp['to'] ? new Date(qp['to']) : null;
      this.dateRange.set([from, to]);
    }

    // Wire the search debounce — only the text input is debounced; all
    // dropdown/date filters fire a fresh query immediately on change.
    this.subscriptions.add(
      this.searchSubject
        .pipe(debounceTime(250), distinctUntilChanged())
        .subscribe(() => {
          this.currentPage = 1;
          this.loadPage(1, this.currentPageSize);
        }),
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  /** Fetches the distinct list of action strings to populate the dropdown. */
  private loadActions(): void {
    this.auditLogService.getActions().subscribe({
      next: (actions) => {
        this.actionOptions.set(
          actions.map((a) => ({
            label: this.actionLabel(a),
            value: a,
          })),
        );
      },
      error: () => {
        // Non-fatal: the dropdown will be empty but filtering still works
        // if the user types a raw action string.
      },
    });
  }

  /**
   * Fetches a page of audit events with the current filter state applied.
   * Called by the PrimeNG lazy-load event and by filter-change handlers.
   */
  loadPage(page: number, limit: number): void {
    this.loading.set(true);

    // Map the visual column field name to the API's sort whitelist.
    const sortKeyByField: Record<string, AuditLogQueryFilters['sort']> = {
      createdAt: 'created_at',
      actorDisplayName: 'actor_user_id',
      action: 'action',
    };

    const filters: AuditLogQueryFilters = {
      page,
      limit,
      sort: sortKeyByField[this.currentSortField] ?? 'created_at',
      direction: this.currentSortOrder === 1 ? 'asc' : 'desc',
    };

    const search = this.searchText().trim();
    if (search) filters.search = search;

    const entityType = this.selectedEntityType();
    if (entityType) filters.entityType = entityType as AuditEvent['entityType'];

    const actorRole = this.selectedActorRole();
    if (actorRole) filters.actorRole = actorRole as AuditEvent['actorRole'];

    const action = this.selectedAction();
    if (action) filters.action = action;

    const [from, to] = this.dateRange();
    if (from) filters.from = from.toISOString();
    if (to) {
      // Set to end of day so the range is inclusive.
      const endOfDay = new Date(to);
      endOfDay.setHours(23, 59, 59, 999);
      filters.to = endOfDay.toISOString();
    }

    // Sync filters to URL.
    this.syncUrl(filters);

    this.auditLogService.query(filters).subscribe({
      next: (res) => {
        this.events.set(res.items);
        this.total.set(res.total);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: 'Failed to load audit events.',
        });
      },
    });
  }

  /**
   * Pushes current filter state into the URL as query params.
   * This enables deep-linking and browser-back navigation to restore filters.
   */
  private syncUrl(filters: AuditLogQueryFilters): void {
    const params: Record<string, string | null> = {
      search: filters.search ?? null,
      entityType: filters.entityType ?? null,
      actorRole: filters.actorRole ?? null,
      action: (filters.action as string | undefined) ?? null,
      from: filters.from ? filters.from.split('T')[0] : null,
      to: filters.to ? filters.to.split('T')[0] : null,
    };

    // Remove null values so the URL stays clean.
    const cleanParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== '') cleanParams[k] = v;
    }

    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: cleanParams,
      replaceUrl: true,
    });
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  /**
   * PrimeNG fires (onLazyLoad) on every page change.
   * `first` is zero-based; we convert to 1-based page number.
   */
  onLazyLoad(event: TableLazyLoadEvent): void {
    const first = event.first ?? 0;
    const rows = event.rows ?? 50;
    this.currentPage = Math.floor(first / rows) + 1;
    this.currentPageSize = rows;

    // Capture sort changes from header clicks. PrimeNG passes sortField as a
    // string|string[]|null|undefined and sortOrder as 1|-1|undefined. Coerce
    // both, falling back to current state when the event omits them (e.g. on
    // pure pagination events).
    const sortField = Array.isArray(event.sortField)
      ? event.sortField[0]
      : event.sortField;
    if (sortField) this.currentSortField = sortField;
    if (event.sortOrder === 1 || event.sortOrder === -1) {
      this.currentSortOrder = event.sortOrder;
    }

    this.loadPage(this.currentPage, rows);
  }

  /** Called on each keystroke in the search input — feeds the debounce subject. */
  onSearchInput(value: string): void {
    this.searchText.set(value);
    this.searchSubject.next(value);
  }

  /** Called when any dropdown filter changes — fires immediately (no debounce). */
  onFilterChange(): void {
    this.currentPage = 1;
    this.loadPage(1, this.currentPageSize);
  }

  /** Called when the date range picker changes. */
  onDateRangeChange(range: (Date | null)[]): void {
    this.dateRange.set(range);
    // Only fire the query once both ends of the range are picked (or both cleared).
    const [from, to] = range;
    const bothPicked = (from !== null && to !== null) || (from === null && to === null);
    if (bothPicked) {
      this.currentPage = 1;
      this.loadPage(1, this.currentPageSize);
    }
  }

  /** Resets all filters and reloads. */
  clearFilters(): void {
    this.searchText.set('');
    this.selectedEntityType.set(null);
    this.selectedActorRole.set(null);
    this.selectedAction.set(null);
    this.dateRange.set([null, null]);
    this.currentPage = 1;
    this.loadPage(1, this.currentPageSize);
  }

  /** Opens the detail drawer for a specific event. */
  viewEvent(event: AuditEvent): void {
    this.selectedEvent.set(event);
    this.drawerOpen.set(true);
  }

  /** Copies the given text to the clipboard and toasts on success. */
  copyToClipboard(text: string | null): void {
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => {
        this.messageService.add({
          severity: 'success',
          summary: 'Copied',
          detail: 'Copied to clipboard.',
          life: 2000,
        });
      },
      () => {
        this.messageService.add({
          severity: 'warn',
          summary: 'Copy failed',
          detail: 'Could not copy to clipboard.',
          life: 2000,
        });
      },
    );
  }

  // -------------------------------------------------------------------------
  // Display helpers — public so the template can call them
  // -------------------------------------------------------------------------

  /** Human-readable role label — delegates to shared util. */
  roleLabel(role: string): string {
    return auditRoleLabel(role as AuditEvent['actorRole']);
  }

  /**
   * Friendly label for an action string — delegates to shared util.
   */
  actionLabel(action: string): string {
    return auditActionLabel(action);
  }

  /** Human-readable label for a camelCase field name — delegates to shared util. */
  fieldLabel(fieldName: string): string {
    return auditFieldLabel(fieldName);
  }

  /** Returns the entity-type icon class for use with PrimeIcons — delegates to shared util. */
  entityIcon(entityType: AuditEvent['entityType']): string {
    return auditEntityIcon(entityType);
  }

  /** Friendly entity-type label — delegates to shared util. */
  entityTypeLabel(entityType: AuditEvent['entityType']): string {
    return auditEntityTypeLabel(entityType);
  }

  /**
   * Formats an audit value for display in the diff table.
   * Delegates to the shared util — see audit-log.utils.ts for full rules.
   */
  formatValue(fieldName: string, value: unknown): string {
    return formatAuditValue(fieldName, value);
  }

  /** True when the formatted value exceeds TRUNCATE_LENGTH characters. */
  valueNeedsTooltip(fieldName: string, value: unknown): boolean {
    return this.formatValue(fieldName, value).length > TRUNCATE_LENGTH;
  }

  /** Truncated version of the formatted value for table cells. */
  truncatedValue(fieldName: string, value: unknown): string {
    const formatted = this.formatValue(fieldName, value);
    if (formatted.length > TRUNCATE_LENGTH) {
      return formatted.slice(0, TRUNCATE_LENGTH) + '…';
    }
    return formatted;
  }

  /** True when the given value is the '<truncated>' sentinel. */
  isTruncatedSentinel(value: unknown): boolean {
    return value === '<truncated>';
  }

  /** Formats an ISO datetime string as "03 May 2026, 17:41" — delegates to shared util. */
  formatTimestamp(isoString: string): string {
    return formatAuditTimestamp(isoString);
  }

  /** True when any filter is currently active. */
  readonly hasActiveFilters = computed(() => {
    const [from, to] = this.dateRange();
    return (
      this.searchText().trim() !== '' ||
      this.selectedEntityType() !== null ||
      this.selectedActorRole() !== null ||
      this.selectedAction() !== null ||
      from !== null ||
      to !== null
    );
  });
}
