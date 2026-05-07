import {
  Component,
  Input,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { TableModule, TableLazyLoadEvent } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { DialogModule } from 'primeng/dialog';
import { DividerModule } from 'primeng/divider';
import { SkeletonModule } from 'primeng/skeleton';

import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditEvent, AuditLogQueryFilters } from '../audit-log/audit-event.model';
import {
  actionLabel,
  formatAuditTimestamp,
  formatAuditValue,
  fieldLabel,
  roleBadgeClass,
  roleLabel,
  entityIcon,
  entityTypeLabel,
} from '../audit-log/audit-log.utils';

// ---------------------------------------------------------------------------
// View mode toggle
// ---------------------------------------------------------------------------

/** Controls which query is active in the history tab. */
type ViewMode = 'on-user' | 'by-user';

// ---------------------------------------------------------------------------
// Diff row model for the detail dialog table
// ---------------------------------------------------------------------------

interface DiffRow {
  field: string;
  before: unknown;
  after: unknown;
}

/** Chars before truncation in table cells. */
const TRUNCATE_LENGTH = 80;

/**
 * UserAuditTabComponent — an inline history tab for the user edit dialog.
 *
 * Shows a PrimeNG p-table of audit events scoped to a single user,
 * with a toggle to switch between:
 *   "Actions on this user"  — GET /audit?entityType=user&entityId=:userId
 *   "Actions by this user"  — GET /audit?actorUserId=:userId
 *
 * Clicking "View" on any row opens a lightweight p-dialog with the full
 * event detail and a before/after diff table when changes are present.
 *
 * Standalone OnPush component using Angular signals for all local state.
 * Uses AuditLogService which is provided at root — no additional providers.
 */
@Component({
  selector: 'app-user-audit-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    TableModule,
    ButtonModule,
    TagModule,
    TooltipModule,
    DialogModule,
    DividerModule,
    SkeletonModule,
  ],
  template: `
    <!-- ── Mode toggle ────────────────────────────────────────────────────── -->
    <div class="uat-mode-bar">
      <div class="uat-mode-tabs">
        <button
          type="button"
          class="uat-mode-tab"
          [class.uat-mode-tab--active]="viewMode() === 'on-user'"
          (click)="setMode('on-user')"
        >
          <i class="pi pi-user"></i>
          Actions on this user
        </button>
        <button
          type="button"
          class="uat-mode-tab"
          [class.uat-mode-tab--active]="viewMode() === 'by-user'"
          (click)="setMode('by-user')"
        >
          <i class="pi pi-sign-out"></i>
          Actions by this user
        </button>
      </div>
    </div>

    <!-- ── Table ──────────────────────────────────────────────────────────── -->
    <div class="uat-table-wrapper">
      <p-table
        [value]="events()"
        [lazy]="true"
        [loading]="loading()"
        [totalRecords]="total()"
        [rows]="25"
        [rowsPerPageOptions]="[25, 50, 100]"
        [paginator]="total() > 25"
        [showCurrentPageReport]="true"
        currentPageReportTemplate="{first}–{last} of {totalRecords}"
        (onLazyLoad)="onLazyLoad($event)"
        styleClass="p-datatable-sm uat-table"
        responsiveLayout="scroll"
      >
        <!-- Headers -->
        <ng-template pTemplate="header">
          <tr>
            <th style="width: 148px">When</th>
            <th style="width: 170px">Action</th>
            @if (viewMode() === 'by-user') {
              <th style="width: 140px">Entity</th>
            }
            <th>Summary</th>
            <th style="width: 72px"></th>
          </tr>
        </ng-template>

        <!-- Body rows -->
        <ng-template pTemplate="body" let-ev>
          <tr>
            <!-- When -->
            <td class="uat-cell uat-cell--ts">
              <span [pTooltip]="ev.createdAt" tooltipPosition="top">
                {{ formatTs(ev.createdAt) }}
              </span>
            </td>

            <!-- Action -->
            <td class="uat-cell">
              <span class="uat-action-label">{{ getActionLabel(ev.action) }}</span>
              @if (ev.action === 'auth.dev_login') {
                <i
                  class="pi pi-key uat-devlogin-icon"
                  pTooltip="Dev-login impersonation"
                  tooltipPosition="top"
                ></i>
              }
            </td>

            <!-- Entity (only in "by this user" mode) -->
            @if (viewMode() === 'by-user') {
              <td class="uat-cell">
                @if (ev.entityId !== null && ev.entityId !== undefined) {
                  <div class="uat-entity">
                    <i [class]="getEntityIcon(ev.entityType) + ' uat-entity__icon'"></i>
                    <span>{{ getEntityTypeLabel(ev.entityType) }} #{{ ev.entityId }}</span>
                  </div>
                } @else {
                  <span class="uat-empty-cell">{{ getEntityTypeLabel(ev.entityType) }}</span>
                }
              </td>
            }

            <!-- Summary -->
            <td class="uat-cell uat-cell--summary">
              @if (ev.summary) {
                @if (ev.summary.length > 80) {
                  <span [pTooltip]="ev.summary" tooltipPosition="top">
                    {{ ev.summary.slice(0, 80) }}…
                  </span>
                } @else {
                  {{ ev.summary }}
                }
              } @else {
                <span class="uat-empty-cell">—</span>
              }
            </td>

            <!-- View button -->
            <td class="uat-cell uat-cell--action">
              <button
                pButton
                type="button"
                label="View"
                icon="pi pi-eye"
                class="p-button-text p-button-sm uat-view-btn"
                (click)="openDetail(ev)"
              ></button>
            </td>
          </tr>
        </ng-template>

        <!-- Empty state -->
        <ng-template pTemplate="emptymessage">
          <tr>
            <td [attr.colspan]="viewMode() === 'by-user' ? 5 : 4" class="uat-empty-state">
              <i class="pi pi-inbox uat-empty-state__icon"></i>
              <p class="uat-empty-state__text">No history yet for this user.</p>
            </td>
          </tr>
        </ng-template>
      </p-table>
    </div>

    <!-- ── Detail dialog ──────────────────────────────────────────────────── -->
    <p-dialog
      [visible]="detailOpen()"
      (visibleChange)="detailOpen.set($event)"
      [header]="'Audit event #' + (selectedEvent()?.id ?? '')"
      [modal]="true"
      [style]="{ width: '560px', maxWidth: '95vw' }"
      [draggable]="false"
      [closable]="true"
      styleClass="uat-detail-dialog"
      appendTo="body"
    >
      @if (selectedEvent(); as ev) {
        <!-- Scalar grid -->
        <dl class="uat-detail-grid">
          <dt>When</dt>
          <dd>
            <span class="uat-detail-ts">{{ ev.createdAt }}</span>
            <span class="uat-detail-ts-friendly">&nbsp;({{ formatTs(ev.createdAt) }})</span>
          </dd>

          <dt>Action</dt>
          <dd>
            <span class="uat-detail-action-label">{{ getActionLabel(ev.action) }}</span>
            <code class="uat-detail-action-raw">{{ ev.action }}</code>
          </dd>

          <dt>Actor</dt>
          <dd>
            <div class="uat-actor">
              <span class="uat-actor__name">{{ ev.actorDisplayName }}</span>
              <p-tag
                [value]="getRoleLabel(ev.actorRole)"
                [styleClass]="getRoleBadgeClass(ev.actorRole)"
              />
              @if (ev.actorEmail) {
                <span class="uat-actor__email">{{ ev.actorEmail }}</span>
              }
            </div>
          </dd>

          <dt>Entity</dt>
          <dd>
            <div class="uat-entity">
              <i [class]="getEntityIcon(ev.entityType) + ' uat-entity__icon'"></i>
              <span>
                {{ getEntityTypeLabel(ev.entityType) }}
                @if (ev.entityId !== null && ev.entityId !== undefined) {
                  #{{ ev.entityId }}
                }
              </span>
            </div>
          </dd>

          @if (ev.summary) {
            <dt>Summary</dt>
            <dd>{{ ev.summary }}</dd>
          }

          @if (ev.justification) {
            <dt>Justification</dt>
            <dd class="uat-detail-justification">{{ ev.justification }}</dd>
          }

          @if (ev.requestId) {
            <dt>Request ID</dt>
            <dd><code class="uat-detail-reqid">{{ ev.requestId }}</code></dd>
          }
        </dl>

        <!-- Diff table — only when there are changes -->
        @if (diffRows().length > 0) {
          <p-divider />
          <h4 class="uat-diff-title">Field changes</h4>
          <table class="uat-diff-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              @for (row of diffRows(); track row.field) {
                <tr>
                  <td class="uat-diff-field">{{ getFieldLabel(row.field) }}</td>
                  <td class="uat-diff-before">
                    @if (row.before === '<truncated>') {
                      <em class="uat-diff-truncated">(value too large)</em>
                    } @else {
                      <span
                        [pTooltip]="needsTooltip(row.field, row.before) ? fmtValue(row.field, row.before) : ''"
                        tooltipPosition="top"
                      >{{ truncatedFmt(row.field, row.before) }}</span>
                    }
                  </td>
                  <td class="uat-diff-after">
                    @if (row.after === '<truncated>') {
                      <em class="uat-diff-truncated">(value too large)</em>
                    } @else {
                      <span
                        [pTooltip]="needsTooltip(row.field, row.after) ? fmtValue(row.field, row.after) : ''"
                        tooltipPosition="top"
                      >{{ truncatedFmt(row.field, row.after) }}</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      }

      <ng-template pTemplate="footer">
        <button
          pButton
          type="button"
          label="Close"
          class="p-button-outlined p-button-sm"
          (click)="detailOpen.set(false)"
        ></button>
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    /* ── Mode toggle bar ────────────────────────────────────────────────── */
    .uat-mode-bar {
      padding: 12px 0 10px;
    }

    .uat-mode-tabs {
      display: inline-flex;
      gap: 0;
      border: 1px solid #e2e2e2;
      border-radius: 8px;
      overflow: hidden;
    }

    .uat-mode-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 16px;
      font-size: 0.8125rem;
      font-weight: 500;
      color: #555555;
      background: #ffffff;
      border: none;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      white-space: nowrap;
      font-family: inherit;

      &:first-child {
        border-right: 1px solid #e2e2e2;
      }

      &:hover:not(.uat-mode-tab--active) {
        background: #f4f2f2;
      }

      &--active {
        background: #5569dd;
        color: #ffffff;
      }

      .pi {
        font-size: 0.8125rem;
      }
    }

    /* ── Table wrapper ──────────────────────────────────────────────────── */
    .uat-table-wrapper {
      background: #ffffff;
      border: 1px solid #e8e6e6;
      border-radius: 8px;
      overflow: hidden;
    }

    /* ── Table cells ────────────────────────────────────────────────────── */
    .uat-cell {
      vertical-align: top;
      padding: 0.45rem 0.65rem !important;

      &--ts {
        font-size: 0.8rem;
        color: #777777;
        white-space: nowrap;
        cursor: default;
      }

      &--summary {
        font-size: 0.875rem;
        color: #555555;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      &--action {
        text-align: right;
        padding-right: 10px !important;
      }
    }

    /* ── Action label ───────────────────────────────────────────────────── */
    .uat-action-label {
      font-size: 0.875rem;
      font-weight: 500;
      color: #333333;
    }

    .uat-devlogin-icon {
      font-size: 0.8125rem;
      color: #d97706;
      margin-left: 6px;
      vertical-align: middle;
    }

    /* ── Entity cell ────────────────────────────────────────────────────── */
    .uat-entity {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.8125rem;
      color: #555555;

      &__icon {
        font-size: 0.8125rem;
        color: #aaaaaa;
        flex-shrink: 0;
      }
    }

    /* ── Empty cell / state ─────────────────────────────────────────────── */
    .uat-empty-cell {
      color: #cccccc;
      font-size: 0.875rem;
    }

    .uat-empty-state {
      text-align: center;
      padding: 2rem 1rem !important;

      &__icon {
        font-size: 2.25rem;
        color: #cccccc;
        display: block;
        margin: 0 auto 10px;
      }

      &__text {
        font-size: 0.9rem;
        color: #999999;
        margin: 0;
      }
    }

    /* ── View button ────────────────────────────────────────────────────── */
    .uat-view-btn {
      font-size: 0.8125rem !important;
    }

    /* ── Table row overrides ────────────────────────────────────────────── */
    ::ng-deep .uat-table {
      .p-datatable-tbody > tr > td {
        vertical-align: top;
        padding: 0.45rem 0.65rem;
      }
    }

    /* ── Role badges (mirrors audit-log.component.scss) ────────────────── */
    ::ng-deep .role-badge {
      font-size: 0.6875rem;
      padding: 2px 7px;
      border-radius: 10px;
      font-weight: 600;
      letter-spacing: 0.03em;
      align-self: flex-start;

      &--admin       { background: #334155 !important; color: #ffffff !important; }
      &--unit_admin  { background: #0d9488 !important; color: #ffffff !important; }
      &--workflow_admin { background: #d97706 !important; color: #ffffff !important; }
      &--center_rep  { background: #e11d48 !important; color: #ffffff !important; }
      &--program_rep { background: #0284c7 !important; color: #ffffff !important; }
      &--system      { background: #64748b !important; color: #ffffff !important; }
    }

    /* ── Detail dialog content ──────────────────────────────────────────── */
    .uat-detail-grid {
      display: grid;
      grid-template-columns: 110px 1fr;
      gap: 9px 14px;
      margin: 0 0 4px;

      dt {
        font-size: 0.8rem;
        font-weight: 600;
        color: #777777;
        padding-top: 2px;
      }

      dd {
        font-size: 0.875rem;
        color: #333333;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
        align-items: flex-start;
        flex-wrap: wrap;
        word-break: break-word;
      }
    }

    .uat-detail-ts {
      font-family: 'Courier New', monospace;
      font-size: 0.8rem;
      color: #555555;
    }

    .uat-detail-ts-friendly {
      font-size: 0.8rem;
      color: #999999;
    }

    .uat-detail-action-label {
      font-weight: 600;
      color: #333333;
    }

    .uat-detail-action-raw {
      font-family: 'Courier New', monospace;
      font-size: 0.75rem;
      color: #777777;
      background: #f4f2f2;
      padding: 1px 5px;
      border-radius: 4px;
    }

    .uat-detail-justification {
      font-style: italic;
      color: #555555;
    }

    .uat-detail-reqid {
      font-family: 'Courier New', monospace;
      font-size: 0.8rem;
      color: #555555;
      background: #f4f2f2;
      padding: 2px 5px;
      border-radius: 4px;
      word-break: break-all;
    }

    .uat-actor {
      display: flex;
      flex-direction: column;
      gap: 3px;

      &__name {
        font-size: 0.875rem;
        font-weight: 500;
        color: #333333;
      }

      &__email {
        font-size: 0.75rem;
        color: #999999;
      }
    }

    /* ── Diff table ─────────────────────────────────────────────────────── */
    .uat-diff-title {
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      color: #999999;
      margin: 0 0 10px;
    }

    .uat-diff-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;

      thead tr {
        border-bottom: 2px solid #e8e6e6;
      }

      th {
        text-align: left;
        padding: 5px 8px;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: #777777;
      }

      td {
        padding: 7px 8px;
        vertical-align: top;
        border-bottom: 1px solid #f4f2f2;
      }

      tbody tr:last-child td {
        border-bottom: none;
      }
    }

    .uat-diff-field {
      font-weight: 600;
      color: #555555;
      width: 130px;
      white-space: nowrap;
    }

    .uat-diff-before {
      color: #777777;
      max-width: 160px;
      overflow-wrap: break-word;
    }

    .uat-diff-after {
      color: #1a7a36;
      font-weight: 500;
      max-width: 160px;
      overflow-wrap: break-word;
    }

    .uat-diff-truncated {
      color: #aaaaaa;
      font-style: italic;
    }
  `],
})
export class UserAuditTabComponent implements OnInit, OnDestroy {
  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  /** The user whose history is being viewed. Required. */
  @Input({ required: true }) userId!: number;

  // -------------------------------------------------------------------------
  // DI
  // -------------------------------------------------------------------------

  private readonly auditLogService = inject(AuditLogService);

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Which query mode is active. */
  readonly viewMode = signal<ViewMode>('on-user');

  /** Events for the current page. */
  readonly events = signal<AuditEvent[]>([]);

  /** Total records for current mode (used by paginator). */
  readonly total = signal(0);

  /** True while an API call is in flight. */
  readonly loading = signal(false);

  /** Current pagination state — reset to page 1 on mode change. */
  private currentPage = 1;
  private currentPageSize = 25;

  // -------------------------------------------------------------------------
  // Detail dialog state
  // -------------------------------------------------------------------------

  /** Whether the event-detail dialog is open. */
  readonly detailOpen = signal(false);

  /** The event currently shown in the detail dialog. */
  readonly selectedEvent = signal<AuditEvent | null>(null);

  /** Diff rows derived from the selected event's changes map. */
  readonly diffRows = computed<{ field: string; before: unknown; after: unknown }[]>(() => {
    const ev = this.selectedEvent();
    if (!ev?.changes) return [];
    return Object.entries(ev.changes).map(([field, { before, after }]) => ({
      field,
      before,
      after,
    }));
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  ngOnInit(): void {
    // Load first page immediately when the tab is rendered.
    this.loadPage(1, this.currentPageSize);
  }

  ngOnDestroy(): void {
    // Nothing to clean up — HTTP calls via service, no subscriptions held.
  }

  // -------------------------------------------------------------------------
  // Mode toggle
  // -------------------------------------------------------------------------

  /**
   * Switches between "on-user" and "by-user" modes.
   * Resets to page 1 and fetches the first page in the new mode.
   */
  setMode(mode: ViewMode): void {
    if (this.viewMode() === mode) return;
    this.viewMode.set(mode);
    this.currentPage = 1;
    this.loadPage(1, this.currentPageSize);
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  /**
   * Builds the appropriate filter for the current mode and fetches a page.
   * "on-user": events where this user is the affected entity.
   * "by-user": events where this user was the actor.
   */
  loadPage(page: number, limit: number): void {
    this.loading.set(true);
    this.currentPage = page;
    this.currentPageSize = limit;

    const filters: AuditLogQueryFilters = {
      page,
      limit,
      sort: 'created_at',
      direction: 'desc',
    };

    if (this.viewMode() === 'on-user') {
      filters.entityType = 'user';
      filters.entityId = this.userId;
    } else {
      filters.actorUserId = this.userId;
    }

    this.auditLogService.query(filters).subscribe({
      next: (res) => {
        this.events.set(res.items);
        this.total.set(res.total);
        this.loading.set(false);
      },
      error: () => {
        this.events.set([]);
        this.total.set(0);
        this.loading.set(false);
      },
    });
  }

  // -------------------------------------------------------------------------
  // PrimeNG lazy-load handler
  // -------------------------------------------------------------------------

  /** PrimeNG fires (onLazyLoad) on page/sort changes. */
  onLazyLoad(event: TableLazyLoadEvent): void {
    const first = event.first ?? 0;
    const rows = event.rows ?? 25;
    const page = Math.floor(first / rows) + 1;
    this.loadPage(page, rows);
  }

  // -------------------------------------------------------------------------
  // Detail dialog
  // -------------------------------------------------------------------------

  /** Opens the detail dialog for the selected event. */
  openDetail(event: AuditEvent): void {
    this.selectedEvent.set(event);
    this.detailOpen.set(true);
  }

  // -------------------------------------------------------------------------
  // Template helpers — thin wrappers around shared utils
  // -------------------------------------------------------------------------

  /** Human-readable timestamp. */
  formatTs(iso: string): string {
    return formatAuditTimestamp(iso);
  }

  /** Friendly action label. */
  getActionLabel(action: string): string {
    return actionLabel(action);
  }

  /** PrimeIcons class for an entity type. */
  getEntityIcon(entityType: AuditEvent['entityType']): string {
    return entityIcon(entityType);
  }

  /** Friendly entity-type label. */
  getEntityTypeLabel(entityType: AuditEvent['entityType']): string {
    return entityTypeLabel(entityType);
  }

  /** CSS class for a role badge. */
  getRoleBadgeClass(role: AuditEvent['actorRole']): string {
    return roleBadgeClass(role);
  }

  /** Human-readable role label. */
  getRoleLabel(role: AuditEvent['actorRole']): string {
    return roleLabel(role);
  }

  /** Human-readable field label. */
  getFieldLabel(fieldName: string): string {
    return fieldLabel(fieldName);
  }

  /** Formatted audit value — delegates to shared util. */
  fmtValue(fieldName: string, value: unknown): string {
    return formatAuditValue(fieldName, value);
  }

  /** True when the formatted value exceeds TRUNCATE_LENGTH. */
  needsTooltip(fieldName: string, value: unknown): boolean {
    return this.fmtValue(fieldName, value).length > TRUNCATE_LENGTH;
  }

  /** Formatted value truncated to TRUNCATE_LENGTH chars. */
  truncatedFmt(fieldName: string, value: unknown): string {
    const formatted = this.fmtValue(fieldName, value);
    return formatted.length > TRUNCATE_LENGTH ? formatted.slice(0, TRUNCATE_LENGTH) + '…' : formatted;
  }
}
