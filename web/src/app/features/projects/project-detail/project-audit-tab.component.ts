import { Component, Input, inject, signal, computed } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';

import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { AuditLogService } from '../../admin/audit-log/audit-log.service';
import { AuditEvent } from '../../admin/audit-log/audit-event.model';

/**
 * Human-readable labels for camelCase field names returned in the `changes` map.
 * Any key not found here falls back to splitting on camelCase boundaries.
 */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  summary: 'Summary',
  results: 'Results',
  funder: 'Funder',
  fundingSource: 'Funding Source',
  startDate: 'Start Date',
  endDate: 'End Date',
  totalBudget: 'Total Budget',
  remainingBudget: 'Remaining Budget',
};

/** Fields whose values should be formatted as USD currency amounts. */
const CURRENCY_FIELDS = new Set(['totalBudget', 'remainingBudget']);

/** Fields whose values should be formatted as dates. */
const DATE_FIELDS = new Set(['startDate', 'endDate']);

/** Maximum characters to render inline; longer values get a tooltip. */
const TRUNCATE_LENGTH = 60;

/**
 * Action types that carry a field-level diff in `changes`.
 * Everything else is treated as a summary-only event (no Before/After columns).
 */
const DIFF_ACTIONS = new Set(['project.update', 'project.metadata_update']);

// ---------------------------------------------------------------------------
// Display row model
// ---------------------------------------------------------------------------

/**
 * Flattened display row produced from one AuditEvent.
 *
 * Update events with multiple changed fields expand into one display row per
 * field. All other event types (create, lock, archive, etc.) produce a single
 * row with `isSummaryOnly = true` — these render the `summary` text in place
 * of the field/before/after cells.
 */
interface AuditDisplayRow {
  /** Unique key for @for tracking (eventId + fieldKey or 'summary'). */
  key: string;
  /** ISO timestamp from the parent AuditEvent. */
  createdAt: string;
  /** Display name snapshot from the event. */
  actorDisplayName: string;
  /** Role snapshot from the event. */
  actorRole: AuditEvent['actorRole'];
  /** Machine-readable action string (e.g. 'project.metadata_update'). */
  action: string;
  /**
   * When true: this row represents a whole-event summary (no field diff).
   * The template should span/merge the field/before/after columns and show
   * `summaryText` instead.
   */
  isSummaryOnly: boolean;
  /** Populated for summary-only rows; null for diff rows. */
  summaryText: string | null;
  /** camelCase field key for diff rows; null for summary rows. */
  fieldKey: string | null;
  /** Previous value for diff rows; undefined for summary rows. */
  before: unknown;
  /** New value for diff rows; undefined for summary rows. */
  after: unknown;
  /**
   * Free-text justification provided by the actor.
   * Shown on every expanded row for a multi-field edit — this is intentional
   * so the context is always visible without having to hunt for the "first" row.
   */
  justification: string | null;
}

/**
 * ProjectAuditTabComponent — shows the paginated edit history for one project.
 *
 * Rendered as a collapsible panel below the main project detail content.
 * Visible to admin, unit_admin, and workflow_admin users only; the parent
 * component (ProjectDetailComponent) controls the @if gate.
 *
 * Data source: GET /audit?entityType=project&entityId=:id (unified audit log).
 *
 * The `changes` map in the new unified schema stores ALL changed fields per
 * logical save — one event row, N field entries. This component flattens
 * that into one display row per (event × field) for diff events, and one
 * summary row for non-diff events (create, lock, archive, etc.).
 */
@Component({
  selector: 'app-project-audit-tab',
  standalone: true,
  imports: [CommonModule, TableModule, TagModule, TooltipModule, ToastModule],
  providers: [MessageService, DatePipe],
  template: `
    <p-toast />

    <!--
      The p-table stays mounted at all times. Switching the subtree
      between a skeleton block and the table tears the table down,
      which causes PrimeNG to re-fire onLazyLoad on every remount and
      creates a fetch loop. Use the table's built-in [loading] mode
      instead (renders a loading overlay over the table itself), and
      surface the empty state via the emptymessage template.
    -->
    <p-table
      [value]="displayRows()"
      [rows]="pageSize"
      [totalRecords]="totalRecords()"
      [lazy]="true"
      [loading]="loading()"
      [paginator]="totalRecords() > pageSize"
      (onLazyLoad)="onPageChange($event)"
      styleClass="p-datatable-sm audit-table"
      responsiveLayout="scroll"
    >
      <ng-template pTemplate="header">
        <tr>
          <th style="width: 160px">Timestamp</th>
          <th style="width: 200px">Actor</th>
          <th style="width: 140px">Field</th>
          <th>Before</th>
          <th>After</th>
          <th>Justification</th>
        </tr>
      </ng-template>

      <ng-template pTemplate="body" let-row>
        @if (row.isSummaryOnly) {
          <!-- Summary-only row: create, lock, archive, snapshot_republished, etc. -->
          <tr class="audit-row--summary">
            <!-- Timestamp -->
            <td class="audit-ts">{{ formatTimestamp(row.createdAt) }}</td>

            <!-- Actor -->
            <td>
              <div class="audit-actor">
                <span class="audit-actor__name">{{ row.actorDisplayName }}</span>
                <p-tag
                  [value]="roleLabel(row.actorRole)"
                  [styleClass]="'role-badge role-badge--' + row.actorRole"
                />
              </div>
            </td>

            <!-- Merged cell: action label + summary text spans Field/Before/After/Justification -->
            <td colspan="4" class="audit-summary-cell">
              <span class="audit-action-label">{{ actionLabel(row.action) }}</span>
              @if (row.summaryText) {
                <span class="audit-summary-text">{{ row.summaryText }}</span>
              }
            </td>
          </tr>
        } @else {
          <!-- Diff row: one field changed -->
          <tr>
            <!-- Timestamp -->
            <td class="audit-ts">{{ formatTimestamp(row.createdAt) }}</td>

            <!-- Actor -->
            <td>
              <div class="audit-actor">
                <span class="audit-actor__name">{{ row.actorDisplayName }}</span>
                <p-tag
                  [value]="roleLabel(row.actorRole)"
                  [styleClass]="'role-badge role-badge--' + row.actorRole"
                />
              </div>
            </td>

            <!-- Field name -->
            <td class="audit-field">{{ fieldLabel(row.fieldKey) }}</td>

            <!-- Previous value -->
            <td class="audit-value">
              {{ truncatedValue(row.fieldKey, row.before) }}
              @if (needsTooltip(row.fieldKey, row.before)) {
                <i
                  class="pi pi-info-circle audit-tooltip-icon"
                  [pTooltip]="String(row.before)"
                  tooltipPosition="top"
                ></i>
              }
            </td>

            <!-- New value -->
            <td class="audit-value audit-value--new">
              {{ truncatedValue(row.fieldKey, row.after) }}
              @if (needsTooltip(row.fieldKey, row.after)) {
                <i
                  class="pi pi-info-circle audit-tooltip-icon"
                  [pTooltip]="String(row.after)"
                  tooltipPosition="top"
                ></i>
              }
            </td>

            <!-- Justification -->
            <td class="audit-justification">
              @if (row.justification) {
                @if (row.justification.length > TRUNCATE_LENGTH) {
                  <span [pTooltip]="row.justification" tooltipPosition="top">
                    {{ row.justification.slice(0, TRUNCATE_LENGTH) }}…
                  </span>
                } @else {
                  {{ row.justification }}
                }
              } @else {
                <span class="audit-empty-cell">—</span>
              }
            </td>
          </tr>
        }
      </ng-template>

      <ng-template pTemplate="emptymessage">
        <tr>
          <td colspan="6" class="audit-empty">No edits recorded for this project.</td>
        </tr>
      </ng-template>
    </p-table>
  `,
  styles: [`
    .audit-empty {
      font-size: 0.875rem;
      color: #999999;
      font-style: italic;
      padding: 1rem 0;
    }

    .audit-empty-cell {
      color: #cccccc;
    }

    .audit-ts {
      font-size: 0.8125rem;
      color: #777777;
      white-space: nowrap;
    }

    .audit-actor {
      display: flex;
      flex-direction: column;
      gap: 4px;

      &__name {
        font-size: 0.875rem;
        font-weight: 500;
        color: #333333;
      }
    }

    .audit-field {
      font-size: 0.875rem;
      font-weight: 600;
      color: #555555;
    }

    .audit-value {
      font-size: 0.875rem;
      color: #777777;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;

      &--new {
        color: #1a7a36;
        font-weight: 500;
      }
    }

    .audit-justification {
      font-size: 0.8125rem;
      color: #555555;
      font-style: italic;
      max-width: 240px;
    }

    .audit-tooltip-icon {
      font-size: 0.75rem;
      color: #aaaaaa;
      margin-left: 4px;
      cursor: help;
    }

    /* Summary-only rows (create, lock, archive, etc.) */
    .audit-row--summary {
      background: #fafbff;
    }

    .audit-summary-cell {
      font-size: 0.875rem;
      color: #555555;
    }

    .audit-action-label {
      font-weight: 600;
      color: #333333;
      margin-right: 8px;
    }

    .audit-summary-text {
      color: #666666;
    }

    /* Role badge color overrides — each role gets a distinct color */
    ::ng-deep .role-badge {
      font-size: 0.6875rem;
      padding: 2px 7px;
      border-radius: 10px;
      font-weight: 600;
      letter-spacing: 0.03em;

      /* admin — slate blue */
      &--admin {
        background: #334155 !important;
        color: #ffffff !important;
      }

      /* unit_admin — teal */
      &--unit_admin {
        background: #0d9488 !important;
        color: #ffffff !important;
      }

      /* workflow_admin — amber */
      &--workflow_admin {
        background: #d97706 !important;
        color: #ffffff !important;
      }

      /* center_rep — rose */
      &--center_rep {
        background: #e11d48 !important;
        color: #ffffff !important;
      }

      /* program_rep — sky blue */
      &--program_rep {
        background: #0284c7 !important;
        color: #ffffff !important;
      }

      /* system — neutral grey */
      &--system {
        background: #64748b !important;
        color: #ffffff !important;
      }
    }

    ::ng-deep .audit-table .p-datatable-tbody > tr > td {
      vertical-align: top;
      padding: 0.5rem 0.75rem;
    }
  `],
})
export class ProjectAuditTabComponent {
  /** The project ID to fetch audit events for. */
  @Input({ required: true }) projectId!: number;

  private readonly auditLogService = inject(AuditLogService);
  private readonly messageService = inject(MessageService);
  private readonly datePipe = inject(DatePipe);

  // Expose constants for template use.
  readonly TRUNCATE_LENGTH = TRUNCATE_LENGTH;
  readonly String = String;

  /** Number of rows per page — matches the API default. */
  readonly pageSize = 50;

  /** True while the API call is in flight. */
  readonly loading = signal(false);

  /**
   * Raw AuditEvent page from the API. Kept as raw data so `displayRows`
   * can re-derive the flattened view reactively via computed().
   */
  private readonly rawEvents = signal<AuditEvent[]>([]);

  /** Total count across all pages, from the API response envelope. */
  readonly totalRecords = signal(0);

  /**
   * Flattened display rows derived from `rawEvents`.
   *
   * Diff events (project.update, project.metadata_update) are expanded into
   * one row per changed field. All other event types produce a single
   * summary-only row so the table's total row count will generally exceed
   * the API page size when multi-field edits are present.
   */
  readonly displayRows = computed<AuditDisplayRow[]>(() => {
    const rows: AuditDisplayRow[] = [];

    for (const event of this.rawEvents()) {
      if (DIFF_ACTIONS.has(event.action) && event.changes) {
        // One display row per (event × changed field).
        const entries = Object.entries(event.changes);
        if (entries.length === 0) {
          // Edge case: diff action but empty changes object — fall through
          // to the summary-only path below so we still show something.
          rows.push(this.makeSummaryRow(event));
        } else {
          for (const [fieldKey, { before, after }] of entries) {
            rows.push({
              key: `${event.id}-${fieldKey}`,
              createdAt: event.createdAt,
              actorDisplayName: event.actorDisplayName,
              actorRole: event.actorRole,
              action: event.action,
              isSummaryOnly: false,
              summaryText: null,
              fieldKey,
              before,
              after,
              justification: event.justification,
            });
          }
        }
      } else {
        // create, lock, reopen, archive, snapshot_republished, etc.
        rows.push(this.makeSummaryRow(event));
      }
    }

    return rows;
  });

  /** PrimeNG fires (onLazyLoad) automatically on first render when [lazy]
   * is true, so no explicit ngOnInit fetch is needed. */

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  /**
   * Loads one page of audit events from the unified /audit endpoint,
   * filtered to this project's entity type + ID.
   */
  private loadPage(page: number): void {
    this.loading.set(true);
    this.auditLogService
      .query({
        entityType: 'project',
        entityId: this.projectId,
        page,
        limit: this.pageSize,
        sort: 'created_at',
        direction: 'desc',
      })
      .subscribe({
        next: (res) => {
          this.rawEvents.set(res.items);
          this.totalRecords.set(res.total);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.messageService.add({
            severity: 'error',
            summary: 'Error',
            detail: 'Failed to load edit history.',
          });
        },
      });
  }

  /**
   * Handler for PrimeNG lazy-load paginator event.
   * `first` is the zero-based row offset; divide by pageSize to get the
   * 1-based page number the API expects.
   */
  onPageChange(event: TableLazyLoadEvent): void {
    const first = event.first ?? 0;
    const rows = event.rows ?? this.pageSize;
    const page = Math.floor(first / rows) + 1;
    this.loadPage(page);
  }

  // -------------------------------------------------------------------------
  // Display helpers
  // -------------------------------------------------------------------------

  /** Builds a summary-only display row for a non-diff AuditEvent. */
  private makeSummaryRow(event: AuditEvent): AuditDisplayRow {
    return {
      key: `${event.id}-summary`,
      createdAt: event.createdAt,
      actorDisplayName: event.actorDisplayName,
      actorRole: event.actorRole,
      action: event.action,
      isSummaryOnly: true,
      summaryText: event.summary,
      fieldKey: null,
      before: undefined,
      after: undefined,
      justification: event.justification,
    };
  }

  /** Human-readable role label for the badge. */
  roleLabel(role: string): string {
    const labels: Record<string, string> = {
      admin: 'Admin',
      unit_admin: 'Unit Admin',
      workflow_admin: 'Workflow Admin',
      center_rep: 'Center Rep',
      program_rep: 'Program Rep',
      system: 'System',
    };
    return labels[role] ?? role;
  }

  /**
   * Human-readable label for a machine action string.
   * Strips the entity prefix and converts snake_case to Title Case.
   */
  actionLabel(action: string): string {
    const labels: Record<string, string> = {
      'project.create': 'Created',
      'project.update': 'Updated',
      'project.metadata_update': 'Metadata updated',
      'project.archive': 'Archived',
      'project.locked': 'Round locked',
      'project.reopened': 'Round reopened',
      'project.snapshot_republished': 'Snapshot republished',
    };
    if (labels[action]) return labels[action];
    // Fallback: strip entity prefix, convert underscores to spaces, title-case.
    const bare = action.includes('.') ? action.split('.').slice(1).join('.') : action;
    return bare.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Human-readable label for a camelCase field name. */
  fieldLabel(fieldName: string | null): string {
    if (!fieldName) return '—';
    return FIELD_LABELS[fieldName] ?? fieldName.replace(/([A-Z])/g, ' $1').trim();
  }

  /**
   * Formats an audit value for display.
   * - Currency fields: formatted as USD.
   * - Date fields: formatted as "DD MMM YYYY".
   * - null / undefined / empty: renders as "—".
   * - Other: rendered as a string.
   */
  formatAuditValue(fieldName: string | null, value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';

    if (fieldName && CURRENCY_FIELDS.has(fieldName)) {
      const num = Number(value);
      if (isNaN(num)) return String(value);
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(num);
    }

    if (fieldName && DATE_FIELDS.has(fieldName)) {
      const formatted = this.datePipe.transform(String(value), 'dd MMM yyyy');
      return formatted ?? String(value);
    }

    return String(value);
  }

  /**
   * Returns the formatted value, truncated to TRUNCATE_LENGTH characters.
   * The full value is available via the tooltip (see needsTooltip).
   */
  truncatedValue(fieldName: string | null, value: unknown): string {
    const formatted = this.formatAuditValue(fieldName, value);
    if (formatted.length > TRUNCATE_LENGTH) {
      return formatted.slice(0, TRUNCATE_LENGTH) + '…';
    }
    return formatted;
  }

  /** True when the formatted value is longer than TRUNCATE_LENGTH chars. */
  needsTooltip(fieldName: string | null, value: unknown): boolean {
    return this.formatAuditValue(fieldName, value).length > TRUNCATE_LENGTH;
  }

  /** Formats an ISO datetime string for the timestamp column. */
  formatTimestamp(isoString: string): string {
    return this.datePipe.transform(isoString, 'dd MMM yyyy, HH:mm') ?? isoString;
  }
}
