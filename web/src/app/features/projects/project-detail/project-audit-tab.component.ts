import { Component, Input, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';

import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { ProjectsService } from '../services/projects.service';
import { ProjectAuditEvent } from '../models/project.model';

/**
 * Human-readable labels for camelCase field names returned by the API.
 * Any field not in this map falls back to the raw key with spaces.
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

/** Maximum characters to render inline; longer values get truncated with a tooltip. */
const TRUNCATE_LENGTH = 60;

/**
 * ProjectAuditTabComponent — shows the paginated edit history for one project.
 *
 * Rendered as a collapsible panel below the main project detail content.
 * Visible to admin, unit_admin, and workflow_admin users only; the parent
 * component (ProjectDetailComponent) controls the @if gate.
 *
 * API: GET /projects/:id/audit?page=X&limit=50 — most-recent-first.
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
      [value]="auditEvents()"
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

        <ng-template pTemplate="body" let-ev>
          <tr>
            <!-- Timestamp -->
            <td class="audit-ts">{{ formatTimestamp(ev.createdAt) }}</td>

            <!-- Actor: full name + role badge -->
            <td>
              <div class="audit-actor">
                <span class="audit-actor__name">
                  {{ ev.actorUser.firstName }} {{ ev.actorUser.lastName }}
                </span>
                <p-tag
                  [value]="roleLabel(ev.actorRole)"
                  [styleClass]="'role-badge role-badge--' + ev.actorRole"
                />
              </div>
            </td>

            <!-- Field name -->
            <td class="audit-field">{{ fieldLabel(ev.fieldName) }}</td>

            <!-- Previous value -->
            <td class="audit-value">
              {{ truncatedValue(ev.fieldName, ev.valueBefore) }}
              @if (needsTooltip(ev.fieldName, ev.valueBefore)) {
                <i
                  class="pi pi-info-circle audit-tooltip-icon"
                  [pTooltip]="String(ev.valueBefore)"
                  tooltipPosition="top"
                ></i>
              }
            </td>

            <!-- New value -->
            <td class="audit-value audit-value--new">
              {{ truncatedValue(ev.fieldName, ev.valueAfter) }}
              @if (needsTooltip(ev.fieldName, ev.valueAfter)) {
                <i
                  class="pi pi-info-circle audit-tooltip-icon"
                  [pTooltip]="String(ev.valueAfter)"
                  tooltipPosition="top"
                ></i>
              }
            </td>

            <!-- Justification -->
            <td class="audit-justification">
              @if (ev.justification) {
                @if (ev.justification.length > TRUNCATE_LENGTH) {
                  <span [pTooltip]="ev.justification" tooltipPosition="top">
                    {{ ev.justification.slice(0, TRUNCATE_LENGTH) }}…
                  </span>
                } @else {
                  {{ ev.justification }}
                }
              } @else {
                <span class="audit-empty-cell">—</span>
              }
            </td>
          </tr>
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

    /* Role badge color overrides — each role gets a distinct color */
    ::ng-deep .role-badge {
      font-size: 0.6875rem;
      padding: 2px 7px;
      border-radius: 10px;
      font-weight: 600;
      letter-spacing: 0.03em;

      /* admin — slate blue (contrast default) */
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

  private readonly projectsService = inject(ProjectsService);
  private readonly messageService = inject(MessageService);
  private readonly datePipe = inject(DatePipe);

  // Expose constant for template use.
  readonly TRUNCATE_LENGTH = TRUNCATE_LENGTH;
  readonly String = String;

  /** Number of rows per page — matches the API default. */
  readonly pageSize = 50;

  /** True while the API call is in flight. The PrimeNG p-table renders its
   * own loading overlay when this is true; we don't need a separate skeleton
   * branch (which would unmount the table and re-fire onLazyLoad — see the
   * comment in the template above). */
  readonly loading = signal(false);

  /** Current page of audit events. */
  readonly auditEvents = signal<ProjectAuditEvent[]>([]);

  /** Total count across all pages, from the API response envelope. */
  readonly totalRecords = signal(0);

  /** PrimeNG fires (onLazyLoad) automatically on first render when [lazy]
   * is true, so no explicit ngOnInit fetch is needed — adding one would
   * race with the lazy event and produce a duplicate request. */

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  /**
   * Loads one page of audit events from the API.
   * Called on init and whenever the PrimeNG paginator fires onLazyLoad.
   */
  private loadPage(page: number): void {
    this.loading.set(true);
    this.projectsService.getAuditHistory(this.projectId, page, this.pageSize).subscribe({
      next: (res) => {
        this.auditEvents.set(res.data);
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
   * The `first` property is the zero-based row offset; divide by pageSize
   * to get the 1-based page number the API expects.
   *
   * PrimeNG types `first` as `number | undefined` and `rows` as
   * `number | null | undefined`; we coerce both with defaults.
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

  /** Human-readable role label for the badge. */
  roleLabel(role: string): string {
    const labels: Record<string, string> = {
      admin: 'Admin',
      unit_admin: 'Unit Admin',
      workflow_admin: 'Workflow Admin',
      center_rep: 'Center Rep',
      program_rep: 'Program Rep',
    };
    return labels[role] ?? role;
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
   * - Text: rendered as-is, truncated to TRUNCATE_LENGTH chars.
   * - null / undefined: renders as "—".
   */
  formatAuditValue(fieldName: string | null, value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';

    if (fieldName && CURRENCY_FIELDS.has(fieldName)) {
      const num = Number(value);
      if (isNaN(num)) return String(value);
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num);
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

  /** True when the full value is longer than TRUNCATE_LENGTH chars. */
  needsTooltip(fieldName: string | null, value: unknown): boolean {
    return this.formatAuditValue(fieldName, value).length > TRUNCATE_LENGTH;
  }

  /** Formats an ISO datetime string for the timestamp column. */
  formatTimestamp(isoString: string): string {
    return this.datePipe.transform(isoString, 'dd MMM yyyy, HH:mm') ?? isoString;
  }
}
