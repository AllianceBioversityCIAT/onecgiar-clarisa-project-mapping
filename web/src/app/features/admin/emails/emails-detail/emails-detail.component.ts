import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { SkeletonModule } from 'primeng/skeleton';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DividerModule } from 'primeng/divider';
import { ConfirmationService, MessageService } from 'primeng/api';

import { EmailsService } from '../emails.service';
import { EmailDetail, EmailStatus } from '../models/email.model';

/** PrimeNG tag severity map — duplicated from the list component so each
 *  standalone component is self-contained without a shared utility. */
const STATUS_SEVERITY: Record<EmailStatus, 'info' | 'warn' | 'success' | 'danger'> = {
  queued: 'info',
  sending: 'warn',
  sent: 'success',
  failed: 'danger',
};

const STATUS_LABELS: Record<EmailStatus, string> = {
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
};

/**
 * EmailsDetailComponent — /admin/emails/:id
 *
 * Shows the full email record including the rendered body (HTML or plain
 * text), extended metadata, and a retry button for failed emails.
 */
@Component({
  selector: 'app-emails-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ButtonModule,
    CardModule,
    TagModule,
    ToastModule,
    SkeletonModule,
    ConfirmDialogModule,
    DividerModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './emails-detail.component.html',
  styleUrl: './emails-detail.component.scss',
})
export class EmailsDetailComponent implements OnInit {
  // ---------------------------------------------------------------------------
  // DI
  // ---------------------------------------------------------------------------

  private readonly emailsService = inject(EmailsService);
  private readonly messageService = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  readonly email = signal<EmailDetail | null>(null);
  readonly loading = signal(false);
  readonly retrying = signal(false);

  /**
   * Safe HTML version of the email body, computed once after loading.
   * Only populated when bodyFormat === 'html'.
   *
   * This call to bypassSecurityTrustHtml is intentional and safe because
   * email bodies are authored entirely by our own backend (NestJS templates);
   * they are never sourced from user-supplied raw HTML. The DomSanitizer
   * bypass allows inline styles and images that Sanitizer would otherwise strip.
   */
  readonly safeBody = signal<SafeHtml | null>(null);

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (isNaN(id) || id <= 0) {
      void this.router.navigate(['/admin/emails']);
      return;
    }
    this.loadEmail(id);
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  private loadEmail(id: number): void {
    this.loading.set(true);
    this.emailsService.findOne(id).subscribe({
      next: (detail) => {
        this.email.set(detail);
        // Pre-compute the safe HTML once so the template can bind to a signal
        // rather than calling bypassSecurityTrustHtml on every change detection.
        if (detail.bodyFormat === 'html') {
          // SAFE: body is self-authored by our backend; never user-supplied HTML.
          this.safeBody.set(this.sanitizer.bypassSecurityTrustHtml(detail.body));
        } else {
          this.safeBody.set(null);
        }
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Failed to load email',
          detail: 'Could not retrieve email details. Please try again.',
          life: 6000,
        });
      },
    });
  }

  /** Reloads the current email detail from the API. */
  refresh(): void {
    const detail = this.email();
    if (!detail) return;
    this.loadEmail(detail.id);
  }

  // ---------------------------------------------------------------------------
  // Retry action
  // ---------------------------------------------------------------------------

  /**
   * Opens a PrimeNG confirm dialog before calling POST /admin/emails/:id/retry.
   * Only shown when status === 'failed'.
   */
  confirmRetry(): void {
    const detail = this.email();
    if (!detail) return;

    this.confirmationService.confirm({
      header: 'Retry email?',
      message:
        'Reset this email to queued so it will be retried by the next worker run. The attempts counter will NOT reset.',
      icon: 'pi pi-refresh',
      acceptLabel: 'Retry',
      rejectLabel: 'Cancel',
      acceptButtonStyleClass: 'p-button-warning',
      accept: () => this.executeRetry(detail.id),
    });
  }

  private executeRetry(id: number): void {
    this.retrying.set(true);
    this.emailsService.retry(id).subscribe({
      next: (updated) => {
        this.email.set(updated);
        // Recompute safe HTML in case the body changed after retry (unlikely
        // but keeps state consistent).
        if (updated.bodyFormat === 'html') {
          // SAFE: same justification as in loadEmail().
          this.safeBody.set(this.sanitizer.bypassSecurityTrustHtml(updated.body));
        } else {
          this.safeBody.set(null);
        }
        this.retrying.set(false);
        this.messageService.add({
          severity: 'success',
          summary: 'Email reset to queued',
          detail: 'The email will be retried on the next worker run.',
          life: 4000,
        });
      },
      error: (err: unknown) => {
        this.retrying.set(false);
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

  statusSeverity(status: EmailStatus): 'info' | 'warn' | 'success' | 'danger' {
    return STATUS_SEVERITY[status] ?? 'info';
  }

  statusLabel(status: EmailStatus): string {
    return STATUS_LABELS[status] ?? status;
  }

  /**
   * Formats an ISO timestamp as "17 May 2026, 14:32".
   * Returns "—" for null/undefined.
   */
  formatDate(iso: string | null | undefined): string {
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
   * Pretty-prints a JSON object for display in the metadata block.
   * Returns null if the value is null/undefined.
   */
  prettyJson(value: Record<string, unknown> | null | undefined): string | null {
    if (value == null) return null;
    return JSON.stringify(value, null, 2);
  }

  private extractErrorMessage(err: unknown): string {
    if (err && typeof err === 'object') {
      const httpErr = err as { error?: { message?: string | string[] } };
      if (httpErr.error?.message) {
        const msg = httpErr.error.message;
        return Array.isArray(msg) ? msg.join(' ') : msg;
      }
    }
    return 'An unexpected error occurred. Please try again.';
  }
}
