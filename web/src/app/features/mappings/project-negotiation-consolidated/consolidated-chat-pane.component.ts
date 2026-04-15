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

import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { Textarea } from 'primeng/textarea';
import { TooltipModule } from 'primeng/tooltip';
import { AvatarModule } from 'primeng/avatar';
import { InputNumberModule } from 'primeng/inputnumber';
import { Popover, PopoverModule } from 'primeng/popover';

import { AuthService } from '../../../core/services/auth.service';
import { MappingsService } from '../services/mappings.service';
import { MessageService } from 'primeng/api';
import { ConsolidatedEvent, ConsolidatedMapping, ConsolidatedView } from '../models/mapping.model';

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
    TagModule,
    ButtonModule,
    Textarea,
    TooltipModule,
    AvatarModule,
    InputNumberModule,
    PopoverModule,
  ],
  template: `
    <!-- Feed scroll container — PrimeNG-styled conversation -->
    <div class="chat-scroll" #feedScroll>

      @if (data().events.length === 0) {
        <div class="chat-empty">
          <i class="pi pi-comments chat-empty__icon"></i>
          <p class="chat-empty__text">No activity yet.</p>
        </div>
      } @else {
        <div class="chat-stream">
          @for (event of data().events; track event.id) {

            @if (event.kind === 'mapping') {
              <!-- Centered inline system notice for negotiation events -->
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
                  <span class="system-notice__actor">{{ event.actorName }}</span>
                  <span class="system-notice__event">{{ getEventLabel(event.eventType) }}</span>
                  @if (event.proposedPercentage !== null) {
                    <p-tag
                      [value]="event.proposedPercentage + '%'"
                      severity="info"
                      styleClass="system-notice__tag"
                    />
                  }
                  <span class="system-notice__time">{{ formatTime(event.createdAt) }}</span>
                </div>
                @if (event.message) {
                  <div class="system-notice__message">"{{ event.message }}"</div>
                }

                <!-- Reply actions — only on the latest actionable proposal per mapping -->
                @if (canReplyTo(event)) {
                  <div class="system-notice__actions">
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
              </div>
            } @else {
              <!-- Chat message — Avatar + bubble, aligned by author -->
              <div
                class="msg-row"
                [class.msg-row--own]="isOwnMessage(event)"
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
                  @if (event.message) {
                    <div class="msg-bubble">
                      <p class="msg-bubble__text">{{ event.message }}</p>
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

    <!-- Counter-Propose popover anchored to the reply button that opened it -->
    <p-popover #counterPopover styleClass="counter-popover">
      @if (counterTarget(); as tgt) {
        <div class="counter-form">
          <p class="counter-form__heading">
            Counter-Propose — {{ tgt.programName ?? 'Program' }}
          </p>
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
          <div class="counter-form__btns">
            <p-button
              label="Send"
              icon="pi pi-check"
              size="small"
              [loading]="counterLoading()"
              [disabled]="counterPct === null"
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

  // -----------------------------------------------------------------------
  // Auth helpers
  // -----------------------------------------------------------------------

  private readonly user = this.authService.currentUser;
  private readonly isCenterRep = this.authService.isCenterRep;
  private readonly isAdmin = this.authService.isAdmin;

  /**
   * Whether the current user may post chat messages.
   * Authorized = admin, center rep of the project's center, or program rep
   * of any program that has an active (non-removed) mapping on this project.
   */
  readonly canCompose = computed(() => {
    if (this.isAdmin() || this.isCenterRep()) return true;
    const u = this.user();
    if (!u || u.role !== 'program_rep') return false;
    // Program rep is authorized if they have any non-removed mapping here.
    return this.data().mappings.some(
      (m) => m.programId === u.programId && m.status !== 'removed',
    );
  });

  constructor() {
    // Auto-scroll to bottom whenever the event list changes (data reload).
    effect(() => {
      // Accessing data() registers this effect as a dependency.
      void this.data().events.length;
      this.shouldScrollToBottom = true;
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom) {
      this.scrollToBottom();
      this.shouldScrollToBottom = false;
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
      initiated: 'Initiated',
      counter_proposed: 'Counter-Proposed',
      agreed: 'Agreed',
      reopened: 'Reopened',
      removed: 'Removed',
      message: 'Message',
    };
    return labels[eventType] ?? eventType;
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
   * For each mapping, the event id of the latest proposal (initiated or
   * counter_proposed) still present in the feed. Reply buttons render only
   * on those events so users always act on the most recent offer.
   */
  readonly latestProposalIdByMapping = computed<Record<number, number>>(() => {
    const map: Record<number, number> = {};
    for (const ev of this.data().events) {
      if (
        ev.kind === 'mapping' &&
        ev.mappingId !== null &&
        (ev.eventType === 'initiated' || ev.eventType === 'counter_proposed')
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
      event.eventType !== 'counter_proposed'
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

    // RBAC: center_rep / admin can act on any; program_rep only on their program.
    if (this.isCenterRep() || this.isAdmin()) return true;
    return u.role === 'program_rep' && u.programId === mapping.programId;
  }

  private findMapping(mappingId: number): ConsolidatedMapping | undefined {
    return this.data().mappings.find((m) => m.id === mappingId);
  }

  // -----------------------------------------------------------------------
  // Reply actions — Agree / Counter-Propose
  // -----------------------------------------------------------------------

  agreeOnEvent(event: ConsolidatedEvent): void {
    if (event.mappingId === null) return;
    const mappingId = event.mappingId;
    this.agreeLoadingId.set(mappingId);

    this.mappingsService.agree(mappingId).subscribe({
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
    this.counterPopoverRef.show(mouseEvent);
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

    this.counterLoading.set(true);
    this.mappingsService
      .counterPropose(target.mappingId, {
        proposedAllocation: pct,
        justification: this.counterMessage.trim(),
      })
      .subscribe({
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
