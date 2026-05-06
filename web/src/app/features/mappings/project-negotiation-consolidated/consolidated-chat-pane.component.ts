import {
  Component,
  input,
  output,
  signal,
  computed,
  inject,
  AfterViewChecked,
  ElementRef,
  ViewChild,
  effect,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgClass } from '@angular/common';

import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { Textarea } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';
import { AvatarModule } from 'primeng/avatar';
import { InputNumberModule } from 'primeng/inputnumber';
import { Popover, PopoverModule } from 'primeng/popover';
import { SelectModule } from 'primeng/select';
import { DialogModule } from 'primeng/dialog';

import { AuthService } from '../../../core/services/auth.service';
import { MappingsService } from '../services/mappings.service';
import { MessageService } from 'primeng/api';
import {
  ConsolidatedEvent,
  ConsolidatedMapping,
  ConsolidatedView,
  Rating,
  RATING_OPTIONS,
} from '../models/mapping.model';

/**
 * ConsolidatedChatPaneComponent — left pane of the consolidated negotiation view.
 *
 * Replaces the old per-program tabbed UI with a single chronological activity
 * feed that shows every negotiation event and free-text chat message in order.
 *
 * Composer at the bottom lets authorized users post chat messages.
 * Auto-scrolls to the bottom on load and after reload.
 */
@Component({
  selector: 'app-consolidated-chat-pane',
  standalone: true,
  imports: [
    FormsModule,
    NgClass,
    TagModule,
    ButtonModule,
    Textarea,
    TooltipModule,
    AvatarModule,
    InputNumberModule,
    PopoverModule,
    SelectModule,
    DialogModule,
  ],
  template: `
    <!-- Feed scroll container — PrimeNG-styled conversation -->
    <div class="chat-viewport">
      <div class="chat-scroll" #feedScroll (scroll)="onFeedScroll()">
        @if (data().events.length === 0) {
          <div class="chat-empty">
            <i class="pi pi-comments chat-empty__icon"></i>
            <p class="chat-empty__text">No activity yet.</p>
          </div>
        } @else {
          <div class="chat-stream">
            @for (event of data().events; track event.id) {
              @if (event.kind === 'mapping' && isUserMappingEvent(event)) {
                <!-- User-driven negotiation event — rendered as a chat
                     message with a structured proposal card attached
                     (WhatsApp-style "message with attachment"). -->
                <div
                  class="msg-row"
                  [class.msg-row--own]="isOwnMessage(event)"
                  [attr.data-action-event-id]="canReplyTo(event) ? event.id : null"
                >
                  @if (!isOwnMessage(event)) {
                    <p-avatar
                      [label]="getInitials(event.actorName)"
                      shape="circle"
                      size="normal"
                      [styleClass]="'msg-avatar msg-avatar--' + event.actorRole"
                    />
                  }

                  <div class="msg-content">
                    <div class="msg-meta">
                      @if (!isOwnMessage(event)) {
                        <span class="msg-meta__name">{{ event.actorName }}</span>
                        <p-tag
                          [value]="getRoleLabel(event.actorRole)"
                          [severity]="getRoleSeverity(event.actorRole)"
                          styleClass="msg-meta__role"
                        />
                      } @else {
                        <span class="msg-meta__name msg-meta__name--own">You</span>
                      }
                      <span class="msg-meta__time">{{ formatTime(event.createdAt) }}</span>
                    </div>

                    <div
                      class="msg-bubble msg-bubble--card"
                      [class.msg-bubble--card-action]="canReplyTo(event)"
                    >
                      <!-- Proposal card header: verb + program + % chip -->
                      <div class="proposal-card__header">
                        <i
                          class="proposal-card__icon"
                          [ngClass]="getEventIcon(event.eventType)"
                        ></i>
                        <span class="proposal-card__verb">{{
                          getEventLabel(event.eventType)
                        }}</span>
                        @if (event.programName) {
                          <span class="proposal-card__program">{{ event.programName }}</span>
                        }
                      </div>

                      @if (event.proposedPercentage !== null) {
                        <div class="proposal-card__pct">
                          <span class="proposal-card__pct-value"
                            >{{ event.proposedPercentage }}%</span
                          >
                          <span class="proposal-card__pct-label">allocation</span>
                        </div>
                      }

                      @if (displayMessage(event.message); as note) {
                        <p class="proposal-card__note">{{ note }}</p>
                      }

                      @if (canReplyTo(event)) {
                        <div class="proposal-card__actions">
                          <p-button
                            label="Agree"
                            icon="pi pi-check"
                            size="small"
                            severity="success"
                            [loading]="agreeLoadingId() === event.mappingId"
                            (onClick)="agreeOnEvent(event)"
                          />
                          <p-button
                            label="Counter-Propose"
                            icon="pi pi-arrow-right-arrow-left"
                            size="small"
                            severity="warn"
                            [outlined]="true"
                            (onClick)="openCounterPopover($event, event)"
                          />
                        </div>
                      }

                      <!-- Accept / Decline a pending program-rep removal
                           request. Only shown on the latest unresolved
                           removal_requested event for a mapping, and
                           only to the center side. -->
                      @if (canResolveRemoval(event)) {
                        <div class="proposal-card__actions">
                          <p-button
                            label="Accept removal"
                            icon="pi pi-check"
                            size="small"
                            severity="danger"
                            [loading]="removalLoadingId() === event.mappingId"
                            (onClick)="acceptRemovalOnEvent(event)"
                          />
                          <p-button
                            label="Decline"
                            icon="pi pi-times"
                            size="small"
                            severity="secondary"
                            [outlined]="true"
                            (onClick)="openDeclineRemovalDialogForEvent(event)"
                          />
                        </div>
                      }
                    </div>
                  </div>

                  @if (isOwnMessage(event)) {
                    <p-avatar
                      [label]="getInitials(event.actorName)"
                      shape="circle"
                      size="normal"
                      [styleClass]="'msg-avatar msg-avatar--own'"
                    />
                  }
                </div>
              } @else if (event.kind === 'mapping') {
                <!-- Pure system events (e.g. flagged_for_assistance) — keep
                     the centered inline notice. -->
                <div class="system-notice">
                  <div class="system-notice__bubble">
                    <i class="pi pi-info-circle system-notice__icon"></i>
                    @if (event.programName) {
                      <p-tag
                        [value]="event.programName"
                        severity="secondary"
                        styleClass="system-notice__tag"
                      />
                    }
                    <span class="system-notice__event">{{ getEventLabel(event.eventType) }}</span>
                    <span class="system-notice__time">{{ formatTime(event.createdAt) }}</span>
                  </div>
                  @if (displayMessage(event.message); as note) {
                    <div class="system-notice__message">"{{ note }}"</div>
                  }
                </div>
              } @else {
                <!-- Chat message — Avatar + bubble, aligned by author -->
                <div class="msg-row" [class.msg-row--own]="isOwnMessage(event)">
                  @if (!isOwnMessage(event)) {
                    <p-avatar
                      [label]="getInitials(event.actorName)"
                      shape="circle"
                      size="normal"
                      [styleClass]="'msg-avatar msg-avatar--' + event.actorRole"
                    />
                  }

                  <div class="msg-content">
                    <div class="msg-meta">
                      @if (!isOwnMessage(event)) {
                        <span class="msg-meta__name">{{ event.actorName }}</span>
                        <p-tag
                          [value]="getRoleLabel(event.actorRole)"
                          [severity]="getRoleSeverity(event.actorRole)"
                          styleClass="msg-meta__role"
                        />
                      } @else {
                        <span class="msg-meta__name msg-meta__name--own">You</span>
                      }
                      <span class="msg-meta__time">{{ formatTime(event.createdAt) }}</span>
                    </div>
                    @if (displayMessage(event.message); as note) {
                      <div class="msg-bubble">
                        <p class="msg-bubble__text">{{ note }}</p>
                      </div>
                    }
                  </div>

                  @if (isOwnMessage(event)) {
                    <p-avatar
                      [label]="getInitials(event.actorName)"
                      shape="circle"
                      size="normal"
                      [styleClass]="'msg-avatar msg-avatar--own'"
                    />
                  }
                </div>
              }
            }
          </div>
        }
      </div>

      <!-- Floating "Action needed" pill — visible when an actionable proposal
           exists but is not currently in the viewport. Click jumps to the
           next pending action and pulses it. -->
      @if (pendingActionsOffscreen() > 0) {
        <button
          type="button"
          class="action-pill"
          (click)="scrollToNextPendingAction()"
          aria-label="Jump to action needed"
        >
          <i class="pi pi-arrow-up action-pill__icon"></i>
          <span class="action-pill__label">Action needed</span>
          <span class="action-pill__badge">{{ pendingActionsOffscreen() }}</span>
        </button>
      }
    </div>

    <!-- Counter-Propose popover anchored to the reply button that opened it -->
    <p-popover #counterPopover styleClass="counter-popover">
      @if (counterTarget(); as tgt) {
        <div class="counter-form">
          <p class="counter-form__heading">Counter-Propose — {{ tgt.programName ?? 'Program' }}</p>
          <label class="counter-form__label">Proposed Allocation (%)</label>
          <p-inputnumber
            [(ngModel)]="counterPct"
            [min]="0"
            [max]="100"
            [step]="0.01"
            [maxFractionDigits]="2"
            styleClass="counter-form__input"
            placeholder="e.g. 35"
          />
          <label class="counter-form__label">Message (optional)</label>
          <textarea
            [(ngModel)]="counterMessage"
            rows="3"
            placeholder="Explain your proposal…"
            class="counter-form__textarea"
          ></textarea>

          <!-- Rating selects — program_rep only -->
          @if (isProgramRep()) {
            <label class="counter-form__label counter-form__label--required">
              Complementarity Rating
            </label>
            <p-select
              [(ngModel)]="counterComplementarityRating"
              [options]="ratingOptions"
              optionLabel="label"
              optionValue="value"
              placeholder="Select rating"
              appendTo="body"
              styleClass="counter-form__select"
            />
            <label class="counter-form__label counter-form__label--required">
              Efficiency Rating
            </label>
            <p-select
              [(ngModel)]="counterEfficiencyRating"
              [options]="ratingOptions"
              optionLabel="label"
              optionValue="value"
              placeholder="Select rating"
              appendTo="body"
              styleClass="counter-form__select"
            />
          }

          <div class="counter-form__btns">
            <p-button
              label="Send"
              icon="pi pi-check"
              size="small"
              [loading]="counterLoading()"
              [disabled]="isCounterSubmitDisabled()"
              (onClick)="submitCounter(counterPopover)"
            />
            <p-button
              label="Cancel"
              icon="pi pi-times"
              size="small"
              severity="secondary"
              [outlined]="true"
              (onClick)="counterPopover.hide()"
            />
          </div>
        </div>
      }
    </p-popover>

    <!-- ----------------------------------------------------------------
         Agree dialog — program_rep only, collects ratings before agreeing
         ---------------------------------------------------------------- -->
    <p-dialog
      header="Agree on Mapping"
      [(visible)]="agreeDialogVisible"
      [modal]="true"
      [style]="{ width: '420px' }"
      [closable]="true"
      (onHide)="cancelAgreeDialog()"
      styleClass="agree-rating-dialog"
    >
      <div class="agree-rating-form">
        <p class="agree-rating-form__hint">Please rate this mapping before agreeing.</p>

        <label class="form-label form-label--required">Complementarity Rating</label>
        <p-select
          [(ngModel)]="agreeComplementarityRating"
          [options]="ratingOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="Select rating"
          appendTo="body"
          styleClass="agree-rating-form__select"
        />

        <label class="form-label form-label--required">Efficiency Rating</label>
        <p-select
          [(ngModel)]="agreeEfficiencyRating"
          [options]="ratingOptions"
          optionLabel="label"
          optionValue="value"
          placeholder="Select rating"
          appendTo="body"
          styleClass="agree-rating-form__select"
        />
      </div>

      <ng-template #footer>
        <p-button
          label="Cancel"
          severity="secondary"
          [outlined]="true"
          (onClick)="cancelAgreeDialog()"
        />
        <p-button
          label="Agree"
          icon="pi pi-check"
          severity="success"
          [disabled]="!agreeComplementarityRating || !agreeEfficiencyRating"
          [loading]="agreeLoadingId() !== null"
          (onClick)="submitAgreeDialog()"
        />
      </ng-template>
    </p-dialog>

    <!-- ----------------------------------------------------------------
         Decline-removal dialog — center side rejecting a pending request
         from the chat. Reason is optional but stored on the audit event.
         ---------------------------------------------------------------- -->
    <p-dialog
      header="Decline Removal Request"
      [(visible)]="declineRemovalDialogVisible"
      [modal]="true"
      [style]="{ width: '460px' }"
      [closable]="true"
      (onHide)="cancelDeclineRemoval()"
      styleClass="agree-rating-dialog"
    >
      <div class="agree-rating-form">
        <p class="agree-rating-form__hint">
          Optionally explain why so the program rep understands the decision —
          this stays in the negotiation thread.
        </p>
        <textarea
          pTextarea
          [(ngModel)]="declineRemovalReason"
          rows="4"
          placeholder="Reason (optional)…"
          class="agree-rating-form__select"
        ></textarea>
      </div>

      <ng-template #footer>
        <p-button
          label="Cancel"
          severity="secondary"
          [outlined]="true"
          (onClick)="cancelDeclineRemoval()"
        />
        <p-button
          label="Decline request"
          icon="pi pi-times"
          severity="secondary"
          [loading]="removalLoadingId() !== null"
          (onClick)="submitDeclineRemoval()"
        />
      </ng-template>
    </p-dialog>

    <!-- Composer — visible when not locked AND user is authorized -->
    @if (!isLocked() && canCompose()) {
      <div class="composer">
        <textarea
          pTextarea
          [(ngModel)]="chatMessage"
          [rows]="1"
          [autoResize]="true"
          placeholder="Write a message… (Enter to send, Shift+Enter for newline)"
          class="composer__textarea"
          (keydown)="onComposerKeydown($event)"
        ></textarea>
        <p-button
          icon="pi pi-send"
          size="small"
          severity="primary"
          [loading]="sending()"
          [disabled]="!chatMessage.trim()"
          (onClick)="sendMessage()"
          pTooltip="Send message"
          tooltipPosition="top"
        />
      </div>
    }
  `,
  styleUrl: './consolidated-chat-pane.component.scss',
})
export class ConsolidatedChatPaneComponent implements AfterViewChecked {
  private readonly authService = inject(AuthService);
  private readonly mappingsService = inject(MappingsService);
  private readonly messageService = inject(MessageService);

  // -----------------------------------------------------------------------
  // Inputs / Outputs
  // -----------------------------------------------------------------------

  readonly data = input.required<ConsolidatedView>();
  readonly isLocked = input<boolean>(false);

  /** Emitted after any action so the parent reloads data. */
  readonly reload = output<void>();

  // -----------------------------------------------------------------------
  // View refs for auto-scroll
  // -----------------------------------------------------------------------

  @ViewChild('feedScroll') feedScrollRef!: ElementRef<HTMLDivElement>;

  // -----------------------------------------------------------------------
  // Local state
  // -----------------------------------------------------------------------

  readonly sending = signal(false);
  chatMessage = '';

  /** Reply-action state. */
  readonly agreeLoadingId = signal<number | null>(null);
  readonly counterLoading = signal(false);
  readonly counterTarget = signal<ConsolidatedEvent | null>(null);
  counterPct: number | null = null;
  counterMessage = '';

  @ViewChild('counterPopover') counterPopoverRef!: Popover;

  /**
   * Flag set to true when we want to scroll to the bottom on next view check.
   * Avoids scrolling on every change-detection cycle.
   */
  private shouldScrollToBottom = false;

  /**
   * Scroll position bookkeeping used to drive the floating "Action needed"
   * pill. The signal is a tick counter — bumped on scroll and on data
   * reload — so the `pendingActionsOffscreen` computed re-evaluates after
   * the user scrolls. We deliberately don't store geometry directly; we
   * read it from the DOM at compute time to stay correct under resize.
   */
  private readonly scrollTick = signal(0);

  /** Last action event id that was scrolled to (used to cycle through). */
  private lastScrolledActionId: number | null = null;

  // -----------------------------------------------------------------------
  // Auth helpers
  // -----------------------------------------------------------------------

  private readonly user = this.authService.currentUser;
  private readonly isCenterRep = this.authService.isCenterRep;
  private readonly isAdmin = this.authService.isAdmin;
  private readonly isWorkflowAdmin = this.authService.isWorkflowAdmin;
  protected readonly isProgramRep = this.authService.isProgramRep;

  /** Rating options exposed to the template for p-select dropdowns. */
  readonly ratingOptions = RATING_OPTIONS;

  /**
   * Agree dialog state — only shown to program_rep.
   * Stores the event that triggered the dialog and the two required ratings.
   */
  readonly agreeDialogVisible = signal(false);
  readonly agreeDialogEvent = signal<ConsolidatedEvent | null>(null);
  agreeComplementarityRating: Rating | null = null;
  agreeEfficiencyRating: Rating | null = null;

  /**
   * Rating selections inside the counter-propose popover.
   * Only rendered/validated when the current user is a program_rep.
   */
  counterComplementarityRating: Rating | null = null;
  counterEfficiencyRating: Rating | null = null;

  /**
   * Removal request state — drives the Accept/Decline buttons that show
   * up on the `removal_requested` proposal card and the decline dialog.
   * `removalLoadingId` mirrors `agreeLoadingId` so each row can show its
   * own spinner during accept/decline.
   */
  readonly removalLoadingId = signal<number | null>(null);
  readonly declineRemovalDialogVisible = signal(false);
  readonly declineRemovalEvent = signal<ConsolidatedEvent | null>(null);
  declineRemovalReason = '';

  /**
   * Whether the current user may post chat messages.
   * Authorized = admin, workflow_admin, center rep of the project's center,
   * or program rep of any program that has an active (non-removed) mapping
   * on this project.
   */
  readonly canCompose = computed(() => {
    if (this.isAdmin() || this.isWorkflowAdmin() || this.isCenterRep()) {
      return true;
    }
    const u = this.user();
    if (!u || u.role !== 'program_rep') return false;
    // Program rep is authorized if they have any non-removed mapping here.
    return this.data().mappings.some((m) => m.programId === u.programId && m.status !== 'removed');
  });

  constructor() {
    // Auto-scroll to bottom whenever the event list changes (data reload).
    effect(() => {
      // Accessing data() registers this effect as a dependency.
      void this.data().events.length;
      this.shouldScrollToBottom = true;
      // Re-evaluate offscreen count after the new events render — the
      // post-render scroll-to-bottom may already cover the actions.
      this.scrollTick.update((n) => n + 1);
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom();
      this.shouldScrollToBottom = false;
      // After auto-scroll lands, recompute the pill visibility so the
      // pill disappears if the user is now looking at the latest action.
      this.scrollTick.update((n) => n + 1);
    }
  }

  // -----------------------------------------------------------------------
  // Display helpers
  // -----------------------------------------------------------------------

  getRoleLabel(role: string): string {
    const map: Record<string, string> = {
      center_rep: 'Center Rep',
      program_rep: 'Program Rep',
      admin: 'Admin',
    };
    return map[role] ?? role;
  }

  getEventLabel(eventType: string): string {
    const labels: Record<string, string> = {
      initiated: 'Proposed allocation',
      counter_proposed: 'Counter-proposal',
      agreed: 'Agreed to allocation',
      reopened: 'Reopened — please re-confirm',
      removed: 'Removed program',
      flagged_for_assistance: 'Flagged for workflow admin',
      negotiation_started: 'Negotiation started',
      removal_requested: 'Requested removal',
      removal_declined: 'Removal request declined',
      message: 'Message',
    };
    return labels[eventType] ?? eventType;
  }

  /**
   * PrimeIcons class for the proposal-card header. Visual cue that
   * differentiates the verb at a glance.
   */
  getEventIcon(eventType: string): string {
    const icons: Record<string, string> = {
      initiated: 'pi pi-flag',
      counter_proposed: 'pi pi-arrow-right-arrow-left',
      agreed: 'pi pi-check-circle',
      reopened: 'pi pi-refresh',
      removed: 'pi pi-times-circle',
      removal_requested: 'pi pi-clock',
      removal_declined: 'pi pi-ban',
    };
    return icons[eventType] ?? 'pi pi-info-circle';
  }

  /**
   * True for negotiation events that originate from a real user move
   * (proposals, agreements, removals, reopens). Those are rendered as
   * chat messages with a structured proposal card. System-only events
   * like `flagged_for_assistance` keep the centered notice style.
   */
  isUserMappingEvent(event: ConsolidatedEvent): boolean {
    if (event.kind !== 'mapping') return false;
    return (
      event.eventType === 'initiated' ||
      event.eventType === 'counter_proposed' ||
      event.eventType === 'agreed' ||
      event.eventType === 'reopened' ||
      event.eventType === 'removed' ||
      event.eventType === 'removal_requested' ||
      event.eventType === 'removal_declined'
    );
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  /** Short time-only format used inside chat bubbles. */
  formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Strips the audit-only `[C:<rating> E:<rating>]` suffix the backend appends
   * to negotiation event justifications. The marker is needed for the audit
   * trail but redundant in the UI, where the rating chips already display the
   * same values. Returns null when the message becomes empty after stripping.
   */
  displayMessage(message: string | null | undefined): string | null {
    if (!message) return null;
    const cleaned = message
      .replace(/\s*\[C:(?:high|medium|low)\s+E:(?:high|medium|low)\]\s*$/i, '')
      .trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  /** Whether this event was authored by the current user. */
  isOwnMessage(event: ConsolidatedEvent): boolean {
    const u = this.user();
    return !!u && u.id === event.actorId;
  }

  /** Two-letter initials for avatar fallback. */
  getInitials(name: string): string {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase() || '?';
  }

  /** PrimeNG Tag severity for the role pill. */
  getRoleSeverity(role: string): 'info' | 'success' | 'secondary' {
    if (role === 'program_rep') return 'success';
    if (role === 'center_rep' || role === 'admin') return 'info';
    return 'secondary';
  }

  /**
   * For each mapping, the event id of the latest open offer still present
   * in the feed. Open offers are `initiated`, `counter_proposed`, and
   * `reopened` — replies always target the most recent one, so reopening
   * a locked round moves the reply buttons onto the fresh reopen event
   * instead of the historical proposals from the prior round.
   */
  readonly latestProposalIdByMapping = computed<Record<number, number>>(() => {
    const map: Record<number, number> = {};
    for (const ev of this.data().events) {
      if (
        ev.kind === 'mapping' &&
        ev.mappingId !== null &&
        (ev.eventType === 'initiated' ||
          ev.eventType === 'counter_proposed' ||
          ev.eventType === 'reopened')
      ) {
        map[ev.mappingId] = ev.id;
      }
    }
    return map;
  });

  /**
   * Returns true when the current user is allowed to Agree / Counter-Propose
   * on this specific proposal event.
   */
  canReplyTo(event: ConsolidatedEvent): boolean {
    if (this.isLocked()) return false;
    if (event.kind !== 'mapping' || event.mappingId === null) return false;
    if (
      event.eventType !== 'initiated' &&
      event.eventType !== 'counter_proposed' &&
      event.eventType !== 'reopened'
    ) {
      return false;
    }
    // Must be the latest proposal for its mapping.
    if (this.latestProposalIdByMapping()[event.mappingId] !== event.id) {
      return false;
    }

    const mapping = this.findMapping(event.mappingId);
    if (!mapping) return false;
    if (mapping.status !== 'negotiating') return false;

    // You can't reply to your own proposal — the other party responds.
    const u = this.user();
    if (!u || u.id === event.actorId) return false;

    // If the current user's side has already agreed to the latest terms,
    // hide the action buttons until the other party either agrees (which
    // flips the mapping to `agreed`) or counter-proposes (which clears
    // both agreement flags and starts a new round). Without this check
    // the buttons stay visible and re-clicking Agree is a no-op against
    // a flag that's already true.
    if (this.isCenterRep() && mapping.centerAgreed) return false;
    if (u.role === 'program_rep' && u.programId === mapping.programId && mapping.programAgreed) {
      return false;
    }
    // Admin / workflow_admin act on whichever side hasn't agreed yet.
    // When both are still pending they can pick either; once a side
    // agrees, only the still-open side remains actionable.
    if (
      (this.isAdmin() || this.isWorkflowAdmin()) &&
      mapping.centerAgreed &&
      mapping.programAgreed
    ) {
      return false;
    }

    // RBAC: center_rep / admin can act on any; program_rep only on their program.
    if (this.isCenterRep() || this.isAdmin() || this.isWorkflowAdmin()) return true;
    return u.role === 'program_rep' && u.programId === mapping.programId;
  }

  /**
   * For each mapping with a *currently pending* removal request, the event
   * id of the `removal_requested` row that raised it. Driven off the
   * mapping's `removalRequested` flag rather than scanning events alone —
   * historical requests that were already declined or accepted have their
   * flag cleared and shouldn't show actions anymore.
   */
  readonly latestRemovalRequestIdByMapping = computed<Record<number, number>>(() => {
    const requestingMappingIds = new Set(
      this.data()
        .mappings.filter((m) => m.removalRequested)
        .map((m) => m.id),
    );
    if (requestingMappingIds.size === 0) return {};

    const map: Record<number, number> = {};
    for (const ev of this.data().events) {
      if (
        ev.kind === 'mapping' &&
        ev.mappingId !== null &&
        ev.eventType === 'removal_requested' &&
        requestingMappingIds.has(ev.mappingId)
      ) {
        // Latest wins because events are sorted oldest-first.
        map[ev.mappingId] = ev.id;
      }
    }
    return map;
  });

  /**
   * Returns true when the current user can Accept or Decline this
   * `removal_requested` event from the chat. Restrictions:
   *  - Round must not be locked.
   *  - Event must be the latest unresolved request for its mapping
   *    (older requests on the same mapping that were already accepted
   *    or declined are display-only).
   *  - Only center side (admin / center_rep / workflow_admin) — the
   *    program rep can't resolve their own request.
   */
  canResolveRemoval(event: ConsolidatedEvent): boolean {
    if (this.isLocked()) return false;
    if (event.kind !== 'mapping' || event.mappingId === null) return false;
    if (event.eventType !== 'removal_requested') return false;
    if (this.latestRemovalRequestIdByMapping()[event.mappingId] !== event.id) {
      return false;
    }
    return this.isCenterRep() || this.isAdmin() || this.isWorkflowAdmin();
  }

  private findMapping(mappingId: number): ConsolidatedMapping | undefined {
    return this.data().mappings.find((m) => m.id === mappingId);
  }

  // -----------------------------------------------------------------------
  // Floating "Action needed" pill
  // -----------------------------------------------------------------------

  /**
   * All mapping events the current user can act on (Agree / Counter-Propose),
   * in chronological order (oldest first). Each event corresponds to one
   * pending decision — there is at most one per mapping (the latest open
   * offer), so the array length is the number of programs awaiting a reply.
   */
  readonly pendingActionEvents = computed<ConsolidatedEvent[]>(() => {
    return this.data().events.filter(
      (ev) => this.canReplyTo(ev) || this.canResolveRemoval(ev),
    );
  });

  /**
   * Number of pending actions whose system-notice is currently scrolled
   * out of view. Drives the visibility of the floating pill — when the
   * user is already looking at all pending actions, no pill is shown.
   *
   * Reads geometry from the DOM rather than caching it so resizes and
   * dynamic content changes don't desync the count. `scrollTick` is read
   * to register the computed as scroll-reactive.
   */
  readonly pendingActionsOffscreen = computed<number>(() => {
    void this.scrollTick();
    const pending = this.pendingActionEvents();
    if (pending.length === 0) return 0;
    const scroller = this.feedScrollRef?.nativeElement;
    if (!scroller) return pending.length;

    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight;
    let offscreen = 0;
    for (const ev of pending) {
      const node = scroller.querySelector<HTMLElement>(`[data-action-event-id="${ev.id}"]`);
      if (!node) {
        offscreen += 1;
        continue;
      }
      const nodeTop = node.offsetTop;
      const nodeBottom = nodeTop + node.offsetHeight;
      // "In view" if at least the top edge is on screen with some headroom.
      const inView = nodeBottom > top + 24 && nodeTop < bottom - 24;
      if (!inView) offscreen += 1;
    }
    return offscreen;
  });

  /** Scroll handler — bumps the tick so the offscreen count recomputes. */
  onFeedScroll(): void {
    this.scrollTick.update((n) => n + 1);
  }

  /**
   * Scrolls to the next pending action that is currently offscreen,
   * cycling through them on repeated clicks. The target node briefly
   * pulses (CSS animation) so the user can spot it after the scroll.
   */
  scrollToNextPendingAction(): void {
    const scroller = this.feedScrollRef?.nativeElement;
    const pending = this.pendingActionEvents();
    if (!scroller || pending.length === 0) return;

    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight;
    const offscreen = pending.filter((ev) => {
      const node = scroller.querySelector<HTMLElement>(`[data-action-event-id="${ev.id}"]`);
      if (!node) return true;
      const nodeTop = node.offsetTop;
      const nodeBottom = nodeTop + node.offsetHeight;
      return !(nodeBottom > top + 24 && nodeTop < bottom - 24);
    });
    if (offscreen.length === 0) return;

    // Cycle: pick the first offscreen action after the last one we jumped to.
    let target = offscreen.find((ev) => ev.id > (this.lastScrolledActionId ?? -1)) ?? offscreen[0];
    this.lastScrolledActionId = target.id;

    const node = scroller.querySelector<HTMLElement>(`[data-action-event-id="${target.id}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Pulse the target so it visually catches the eye after the scroll
    // settles. The CSS animation auto-removes itself; we strip the class
    // afterwards so a second jump re-triggers the animation.
    node.classList.remove('action-pulse');
    // Force reflow so re-adding the class restarts the animation.
    void node.offsetWidth;
    node.classList.add('action-pulse');
    window.setTimeout(() => node.classList.remove('action-pulse'), 1600);
  }

  // -----------------------------------------------------------------------
  // Reply actions — Agree / Counter-Propose
  // -----------------------------------------------------------------------

  /**
   * Entry point for the Agree button in the chat feed.
   *
   * - program_rep: opens the rating dialog first; submission happens in submitAgreeDialog.
   * - all other roles: posts agreement directly with no ratings.
   */
  agreeOnEvent(event: ConsolidatedEvent): void {
    if (event.mappingId === null) return;

    if (this.isProgramRep()) {
      this.agreeDialogEvent.set(event);
      this.agreeComplementarityRating = null;
      this.agreeEfficiencyRating = null;
      this.agreeDialogVisible.set(true);
    } else {
      this.sendAgree(event.mappingId);
    }
  }

  /** Called by the rating dialog Agree button for program_rep. */
  submitAgreeDialog(): void {
    const event = this.agreeDialogEvent();
    if (!event?.mappingId || !this.agreeComplementarityRating || !this.agreeEfficiencyRating)
      return;

    this.agreeDialogVisible.set(false);
    this.sendAgree(event.mappingId, {
      complementarityRating: this.agreeComplementarityRating,
      efficiencyRating: this.agreeEfficiencyRating,
    });
  }

  cancelAgreeDialog(): void {
    this.agreeDialogVisible.set(false);
    this.agreeDialogEvent.set(null);
    this.agreeComplementarityRating = null;
    this.agreeEfficiencyRating = null;
  }

  // -----------------------------------------------------------------------
  // Reply actions — Accept / Decline a pending program-rep removal request
  // -----------------------------------------------------------------------

  /**
   * Center side accepts a pending removal request from the chat. Reuses
   * the regular `/remove` endpoint — the service detects the pending flag
   * and merges the program rep's reason into the audit event, so callers
   * here only need to send a short acknowledgment.
   */
  acceptRemovalOnEvent(event: ConsolidatedEvent): void {
    if (event.mappingId === null) return;
    const mapping = this.findMapping(event.mappingId);
    if (!mapping || !mapping.removalRequested) return;

    const ack = 'Accepted program-rep removal request.';
    this.removalLoadingId.set(event.mappingId);
    this.mappingsService.removeProgram(event.mappingId, ack).subscribe({
      next: () => {
        this.messageService.add({
          severity: 'info',
          summary: 'Removal Accepted',
          detail: `${mapping.programName} has been removed from this project.`,
        });
        this.reload.emit();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to accept removal.',
        });
        this.removalLoadingId.set(null);
      },
      complete: () => this.removalLoadingId.set(null),
    });
  }

  openDeclineRemovalDialogForEvent(event: ConsolidatedEvent): void {
    if (event.mappingId === null) return;
    this.declineRemovalEvent.set(event);
    this.declineRemovalReason = '';
    this.declineRemovalDialogVisible.set(true);
  }

  cancelDeclineRemoval(): void {
    this.declineRemovalDialogVisible.set(false);
    this.declineRemovalEvent.set(null);
    this.declineRemovalReason = '';
  }

  submitDeclineRemoval(): void {
    const event = this.declineRemovalEvent();
    if (!event?.mappingId) return;
    const reason = this.declineRemovalReason.trim() || undefined;
    const mappingId = event.mappingId;

    this.removalLoadingId.set(mappingId);
    this.mappingsService.declineRemoval(mappingId, reason).subscribe({
      next: () => {
        const mapping = this.findMapping(mappingId);
        this.declineRemovalDialogVisible.set(false);
        this.declineRemovalEvent.set(null);
        this.declineRemovalReason = '';
        this.messageService.add({
          severity: 'info',
          summary: 'Removal Declined',
          detail: mapping
            ? `Request to remove ${mapping.programName} was declined.`
            : 'Removal request was declined.',
        });
        this.reload.emit();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to decline removal.',
        });
        this.removalLoadingId.set(null);
      },
      complete: () => this.removalLoadingId.set(null),
    });
  }

  /** Internal: posts to /agree with an optional ratings payload. */
  private sendAgree(
    mappingId: number,
    dto?: { complementarityRating?: Rating; efficiencyRating?: Rating },
  ): void {
    this.agreeLoadingId.set(mappingId);
    this.mappingsService.agree(mappingId, dto).subscribe({
      next: () => {
        this.messageService.add({
          severity: 'success',
          summary: 'Agreed',
          detail: 'You have agreed to the current allocation terms.',
        });
        this.reload.emit();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to submit agreement.',
        });
        this.agreeLoadingId.set(null);
      },
      complete: () => this.agreeLoadingId.set(null),
    });
  }

  openCounterPopover(mouseEvent: MouseEvent, event: ConsolidatedEvent): void {
    this.counterTarget.set(event);
    // Prefill with the event's own proposed percentage as a starting point.
    this.counterPct = event.proposedPercentage;
    this.counterMessage = '';
    this.counterComplementarityRating = null;
    this.counterEfficiencyRating = null;
    this.counterPopoverRef.show(mouseEvent);
  }

  /**
   * Whether the counter-propose Send button should be disabled.
   * For program_rep: both ratings are also required.
   */
  isCounterSubmitDisabled(): boolean {
    if (this.counterPct === null) return true;
    if (this.isProgramRep()) {
      return !this.counterComplementarityRating || !this.counterEfficiencyRating;
    }
    return false;
  }

  submitCounter(popover: Popover): void {
    const target = this.counterTarget();
    const pct = this.counterPct;
    if (!target || target.mappingId === null || pct === null || pct < 0 || pct > 100) {
      this.messageService.add({
        severity: 'warn',
        summary: 'Invalid',
        detail: 'Please enter an allocation between 0 and 100.',
      });
      return;
    }

    // Build DTO; program_rep must include ratings.
    const dto = this.isProgramRep()
      ? {
          proposedAllocation: pct,
          justification: this.counterMessage.trim(),
          complementarityRating: this.counterComplementarityRating ?? undefined,
          efficiencyRating: this.counterEfficiencyRating ?? undefined,
        }
      : {
          proposedAllocation: pct,
          justification: this.counterMessage.trim(),
        };

    this.counterLoading.set(true);
    this.mappingsService.counterPropose(target.mappingId, dto).subscribe({
      next: () => {
        popover.hide();
        this.counterTarget.set(null);
        this.messageService.add({
          severity: 'success',
          summary: 'Counter-Proposal Submitted',
          detail: `Proposed ${pct}% sent.`,
        });
        this.reload.emit();
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to submit counter-proposal.',
        });
        this.counterLoading.set(false);
      },
      complete: () => this.counterLoading.set(false),
    });
  }

  // -----------------------------------------------------------------------
  // Composer
  // -----------------------------------------------------------------------

  /**
   * Handles keydown on the composer textarea.
   * Enter sends; Shift+Enter inserts a newline.
   */
  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  sendMessage(): void {
    const text = this.chatMessage.trim();
    if (!text) return;

    const projectId = this.data().project.id;
    this.sending.set(true);

    this.mappingsService.postChatMessage(projectId, text).subscribe({
      next: () => {
        this.chatMessage = '';
        this.reload.emit(); // Parent reloads; server event row appears in feed.
      },
      error: (err) => {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: err?.error?.message ?? 'Failed to send message.',
        });
        this.sending.set(false);
      },
      complete: () => this.sending.set(false),
    });
  }

  // -----------------------------------------------------------------------
  // Scroll helper
  // -----------------------------------------------------------------------

  private scrollToBottom(): void {
    const el = this.feedScrollRef?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }
}
