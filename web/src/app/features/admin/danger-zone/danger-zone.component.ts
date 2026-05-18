import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { ToastModule } from 'primeng/toast';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { ConfirmationService, MessageService } from 'primeng/api';

import { ApiService } from '../../../core/services/api.service';
import { firstValueFrom } from 'rxjs';

/**
 * Shape of the successful response from POST /admin/danger-zone/reset-projects.
 */
interface ResetProjectsResponse {
  deleted: {
    mappingNegotiations: number;
    projectNegotiationMessages: number;
    projectMappings: number;
    projectBudgets: number;
    projectCountries: number;
    projectExclusions: number;
    projects: number;
  };
  durationMs: number;
}

/**
 * DangerZoneComponent — admin-only page for destructive operations.
 *
 * Currently supports a single action: "Reset All Project Data", which wipes
 * all project rows and every dependent table so an admin can perform a fresh
 * Anaplan import. The user must type a confirmation phrase exactly before the
 * action button enables, and must confirm once more via PrimeNG ConfirmDialog
 * before the POST is fired.
 *
 * State is purely local / signal-based and resets on component destruction
 * (each page visit starts fresh).
 */
@Component({
  selector: 'app-danger-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    CardModule,
    ButtonModule,
    InputTextModule,
    MessageModule,
    ToastModule,
    ConfirmDialogModule,
  ],
  providers: [ConfirmationService],
  templateUrl: './danger-zone.component.html',
  styleUrl: './danger-zone.component.scss',
})
export class DangerZoneComponent {
  private readonly api = inject(ApiService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly messageService = inject(MessageService);

  /** Required phrase — must match backend expectation, case-sensitively. */
  readonly REQUIRED_PHRASE = 'RESET PROJECTS';

  /** What the user has typed into the confirmation input. */
  readonly confirmationText = signal('');

  /** True while the HTTP request is in flight. */
  readonly isResetting = signal(false);

  /**
   * Result from the last successful reset, or null when no reset has been
   * performed yet (or after the form was cleared).
   */
  readonly lastResult = signal<ResetProjectsResponse | null>(null);

  /**
   * The delete button is enabled only when the trimmed input matches the
   * required phrase exactly AND no request is currently in flight.
   */
  readonly canReset = computed(
    () => this.confirmationText().trim() === this.REQUIRED_PHRASE && !this.isResetting(),
  );

  /**
   * Opens the PrimeNG ConfirmDialog for a final "are you sure?" check before
   * the irreversible HTTP call is made.
   *
   * Guard: if the phrase is not valid (button should not have been clickable),
   * bail out early to prevent accidental invocation.
   */
  requestReset(): void {
    if (!this.canReset()) {
      return;
    }

    this.confirmationService.confirm({
      header: 'Absolutely sure?',
      message:
        'This wipes all rows across 7 tables — projects, mappings, negotiation threads, chat, budgets, country links, and exclusions. This cannot be undone.',
      acceptLabel: 'Yes, delete everything',
      rejectLabel: 'No, cancel',
      acceptButtonStyleClass: 'p-button-danger',
      accept: () => this.executeReset(),
    });
  }

  /**
   * Executes the actual POST after the user has confirmed via the dialog.
   * Sends the typed phrase verbatim (trimmed) as the body confirmation field.
   */
  private async executeReset(): Promise<void> {
    this.isResetting.set(true);
    this.lastResult.set(null);

    try {
      const result = await firstValueFrom(
        this.api.post<ResetProjectsResponse>('/admin/danger-zone/reset-projects', {
          confirmation: this.confirmationText().trim(),
        }),
      );

      this.lastResult.set(result);
      this.confirmationText.set('');

      const d = result.deleted;
      const detail =
        `Deleted: ${d.projects} projects, ${d.projectMappings} mappings, ` +
        `${d.mappingNegotiations} negotiation events, ${d.projectNegotiationMessages} chat messages, ` +
        `${d.projectBudgets} budget rows, ${d.projectCountries} country links, ` +
        `${d.projectExclusions} exclusions. ` +
        `Completed in ${result.durationMs} ms.`;

      this.messageService.add({
        severity: 'success',
        summary: 'Reset complete',
        detail,
        life: 10000,
      });
    } catch (err: unknown) {
      const message = this.extractErrorMessage(err);
      this.messageService.add({
        severity: 'error',
        summary: 'Reset failed',
        detail: message,
        life: 8000,
      });
    } finally {
      this.isResetting.set(false);
    }
  }

  /**
   * Extracts a human-readable message from an HTTP error response or a
   * generic Error object, falling back to a generic string.
   */
  private extractErrorMessage(err: unknown): string {
    if (err && typeof err === 'object') {
      const httpErr = err as { error?: { message?: string }; message?: string };
      if (httpErr.error?.message) {
        return httpErr.error.message;
      }
      if (httpErr.message) {
        return httpErr.message;
      }
    }
    return 'An unexpected error occurred. Check the console for details.';
  }
}
