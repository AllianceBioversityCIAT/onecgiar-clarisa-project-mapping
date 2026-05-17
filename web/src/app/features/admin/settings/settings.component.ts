import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { MessageService } from 'primeng/api';

import { SettingsService } from './settings.service';
import { UpdateSettingsPayload } from './settings.model';
import { EmailsService } from '../emails/emails.service';
import { UsersService } from '../../users/services/users.service';
import { UserWithRelations } from '../../users/models/user-management.model';

/**
 * SettingsComponent — admin-only page for managing global system settings.
 *
 * Displays three card sections:
 *   1. Email Notifications — toggle to enable/disable the email module.
 *   2. Mapping Deadline — toggle + date picker to set a future deadline for
 *      center reps to complete program mapping.
 *   3. Send Test Email — enqueue a test email to a chosen active user to
 *      verify the email pipeline independently of the global toggle.
 *
 * On init the form is hydrated from GET /settings. On save, PATCH /settings is
 * called; the backend validates the deadline date (must be future when enabled).
 * Server-side error messages are surfaced verbatim in the error toast so the
 * user sees the exact constraint that was violated.
 */
@Component({
  selector: 'app-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    ButtonModule,
    CardModule,
    DatePickerModule,
    MessageModule,
    SelectModule,
    ToastModule,
    ToggleSwitchModule,
  ],
  providers: [MessageService],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly settingsService = inject(SettingsService);
  private readonly emailsService = inject(EmailsService);
  private readonly usersService = inject(UsersService);
  private readonly messageService = inject(MessageService);
  private readonly router = inject(Router);

  /** Reactive form with the three editable settings fields. */
  form!: FormGroup;

  /** True while the initial GET /settings request is in flight. */
  readonly loading = signal(false);

  /** True while the PATCH /settings request is in flight. */
  readonly saving = signal(false);

  // ── Send Test Email card state ────────────────────────────────────────────

  /**
   * Full list of active users loaded once on init, used to populate the
   * recipient p-select picker.  Inactive users are filtered client-side
   * so we never display deactivated accounts as valid recipients.
   */
  readonly users = signal<UserWithRelations[]>([]);

  /**
   * The user-id selected in the recipient p-select.
   * Null when no selection has been made or after a successful send (reset).
   */
  readonly selectedUserId = signal<number | null>(null);

  /** True while the POST /admin/emails/test-send request is in flight. */
  readonly sending = signal(false);

  /**
   * After a successful test-send, holds the id of the newly created email
   * so the inline "View in queue" link can navigate to the detail page.
   * Reset to null on the next send attempt.
   */
  readonly lastSentEmailId = signal<number | null>(null);

  /**
   * The earliest selectable date in the deadline picker — tomorrow.
   * Computed once on construction; the day boundary is not reactive.
   */
  readonly tomorrow: Date = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d;
  })();

  /**
   * Signal mirror of the form value — updated on every valueChanges emission.
   * Required so computed() can track it reactively.
   */
  private readonly formValues = signal<{
    emailEnabled: boolean;
    deadlineEnabled: boolean;
    deadlineDate: Date | null;
  }>({ emailEnabled: false, deadlineEnabled: false, deadlineDate: null });

  ngOnInit(): void {
    this.form = this.fb.group({
      emailEnabled: [false],
      deadlineEnabled: [false],
      deadlineDate: [null as Date | null],
    });

    // Keep formValues signal in sync so computed() can react.
    this.form.valueChanges.subscribe((v) => this.formValues.set(v));

    // When the deadline toggle changes: clear the date if turning off, then auto-save.
    // Pass the fresh `enabled` value as a parameter — `form.value` still holds the
    // PREVIOUS toggle state when the per-control subscriber fires.
    this.form.get('deadlineEnabled')!.valueChanges.subscribe((enabled: boolean) => {
      if (!enabled) {
        this.form.get('deadlineDate')!.setValue(null, { emitEvent: false });
      }
      this.autoSaveDeadline({ deadlineEnabled: enabled, deadlineDate: enabled ? (this.form.get('deadlineDate')!.value as Date | null) : null });
    });

    // Auto-save when the date changes. Pass the fresh Date as a parameter — same
    // staleness reason as above.
    this.form
      .get('deadlineDate')!
      .valueChanges.subscribe((v: Date | string | null) => {
        if (!(v instanceof Date)) return;
        this.autoSaveDeadline({ deadlineEnabled: true, deadlineDate: v });
      });

    // Auto-save when the email toggle is flipped. Initial hydration is excluded
    // because loadSettings() patches with { emitEvent: false }.
    this.form.get('emailEnabled')!.valueChanges.subscribe((enabled: boolean) => {
      this.autoSaveEmailEnabled(enabled);
    });

    this.loadSettings();
    this.loadUsers();
  }

  /**
   * Fetches current settings from the backend and patches the form.
   * If deadlineDate is in the past (legacy data) it is still patched in —
   * the Save button stays disabled until the user picks a future date or
   * disables the deadline toggle.
   */
  private async loadSettings(): Promise<void> {
    this.loading.set(true);
    try {
      const settings = await firstValueFrom(this.settingsService.getSettings());

      // Convert ISO date string to a Date object for the p-datepicker binding.
      const deadlineDateValue = settings.deadlineDate ? new Date(settings.deadlineDate) : null;

      // emitEvent: false prevents the emailEnabled valueChanges subscription
      // from firing a premature auto-save during initial hydration.
      this.form.patchValue(
        {
          emailEnabled: settings.emailEnabled,
          deadlineEnabled: settings.deadlineEnabled,
          deadlineDate: deadlineDateValue,
        },
        { emitEvent: false },
      );
    } catch {
      this.messageService.add({
        severity: 'error',
        summary: 'Failed to load settings',
        detail: 'Could not retrieve system settings. Please refresh the page.',
        life: 6000,
      });
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Immediately persists the emailEnabled flag to the backend when the toggle
   * is flipped.  Skips silently if a save is already in progress.  On failure
   * reverts the toggle to its previous value and shows an error toast.
   */
  private async autoSaveEmailEnabled(enabled: boolean): Promise<void> {
    // Guard: skip if another save is already in flight.
    if (this.saving()) return;

    const raw = this.form.getRawValue();
    const payload: UpdateSettingsPayload = {
      emailEnabled: enabled,
      deadlineEnabled: raw.deadlineEnabled,
      deadlineDate: raw.deadlineDate ? this.toDateString(raw.deadlineDate as Date) : null,
    };

    this.saving.set(true);
    try {
      await firstValueFrom(this.settingsService.updateSettings(payload));
      this.messageService.add({
        severity: 'success',
        summary: enabled ? 'Email notifications enabled' : 'Email notifications disabled',
        detail: enabled
          ? 'The email dispatch worker will now process queued messages.'
          : 'The email dispatch worker is paused. Queued messages will not be sent.',
        life: 4000,
      });
    } catch (err: unknown) {
      // Revert the toggle so the UI reflects the actual server state.
      this.form.patchValue({ emailEnabled: !enabled }, { emitEvent: false });
      const detail = this.extractErrorMessage(err);
      this.messageService.add({
        severity: 'error',
        summary: 'Failed to update email notifications',
        detail,
        life: 8000,
      });
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Immediately persists the deadline settings to the backend when either the
   * deadlineEnabled toggle or the deadlineDate picker changes.
   *
   * Guards:
   *  - Skips silently if another save is already in flight.
   *  - Skips if the toggle is on but no date has been chosen yet — the form
   *    is in a valid in-progress state; we wait for the user to pick a date.
   *  - Skips if the toggle is on and the loaded date is in the past (legacy
   *    data from server); shows an info toast prompting the user to pick a
   *    new future date rather than firing a guaranteed-400 request.
   *
   * On error, re-fetches from the server (emitEvent: false) to revert the
   * form to the last known good state without triggering another auto-save.
   */
  private async autoSaveDeadline(fresh: {
    deadlineEnabled: boolean;
    deadlineDate: Date | null;
  }): Promise<void> {
    // Guard: skip if another save is already in flight.
    if (this.saving()) return;

    // Use the fresh per-control values passed in. `form.value` is unreliable
    // here because the form-level aggregate lags behind per-control valueChanges
    // by one tick. Pull emailEnabled (unrelated field) from the form directly —
    // it's always up to date relative to this stream.
    const vals = {
      emailEnabled: this.form.get('emailEnabled')!.value as boolean,
      deadlineEnabled: fresh.deadlineEnabled,
      deadlineDate: fresh.deadlineDate,
    };

    // Guard: deadline enabled but no date selected yet — wait for the user.
    if (vals.deadlineEnabled && !vals.deadlineDate) {
      return;
    }

    // Guard: deadline enabled but the date is today or in the past.
    if (vals.deadlineEnabled && vals.deadlineDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const picked = new Date(vals.deadlineDate);
      picked.setHours(0, 0, 0, 0);
      if (picked <= today) {
        this.messageService.add({
          severity: 'info',
          summary: 'Pick a future date',
          detail: 'The deadline date must be strictly in the future.',
          life: 4000,
        });
        return;
      }
    }

    this.saving.set(true);
    try {
      const payload: UpdateSettingsPayload = {
        emailEnabled: vals.emailEnabled,
        deadlineEnabled: vals.deadlineEnabled,
        deadlineDate:
          vals.deadlineEnabled && vals.deadlineDate ? this.toDateString(vals.deadlineDate) : null,
      };

      await firstValueFrom(this.settingsService.updateSettings(payload));
      this.messageService.add({
        severity: 'success',
        summary: vals.deadlineEnabled ? 'Deadline updated' : 'Deadline disabled',
        detail: vals.deadlineEnabled
          ? `Deadline set to ${this.toDateString(vals.deadlineDate!)}.`
          : 'Mapping deadline has been disabled.',
        life: 3000,
      });
    } catch (err: unknown) {
      const detail = this.extractErrorMessage(err);
      this.messageService.add({
        severity: 'error',
        summary: 'Failed to save deadline',
        detail,
        life: 5000,
      });
      // Re-hydrate from server so the form reflects actual server state.
      // loadSettings() uses emitEvent: false, so this will not trigger
      // another auto-save loop.
      await this.loadSettings();
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Fetches all users once on component init and filters to active-only.
   * The GET /users endpoint returns the full list without server-side
   * active filtering; we prune inactive records client-side so deactivated
   * accounts never appear as recipient options.
   *
   * Errors here are non-fatal — the send card simply shows an empty picker
   * with a toast warning so the rest of the page remains functional.
   */
  private async loadUsers(): Promise<void> {
    try {
      const all = await firstValueFrom(this.usersService.getUsers());
      this.users.set(all.filter((u) => u.isActive));
    } catch {
      this.messageService.add({
        severity: 'warn',
        summary: 'Could not load users',
        detail: 'The recipient list is unavailable. Refresh the page to try again.',
        life: 6000,
      });
    }
  }

  /**
   * Enqueues a test email to the selected user via POST /admin/emails/test-send.
   *
   * On success:
   *   - Shows a success toast.
   *   - Stores the new email id so the inline "View in queue" link can route
   *     to /admin/emails/:id.
   *   - Clears the recipient selection so the admin can send another immediately.
   *
   * On error:
   *   - Shows an error toast with the backend message when available.
   *   - Clears lastSentEmailId so the stale link from a previous send is hidden.
   */
  async sendTestEmail(): Promise<void> {
    const userId = this.selectedUserId();
    if (userId === null || this.sending()) return;

    this.sending.set(true);
    this.lastSentEmailId.set(null);

    try {
      const result = await firstValueFrom(this.emailsService.sendTest(userId));

      this.messageService.add({
        severity: 'success',
        summary: 'Test email queued',
        detail: `Test email queued — id #${result.id}`,
        life: 6000,
      });

      this.lastSentEmailId.set(result.id);
      this.selectedUserId.set(null);
    } catch (err: unknown) {
      const detail = this.extractErrorMessage(err);
      this.messageService.add({
        severity: 'error',
        summary: 'Failed to send test email',
        detail,
        life: 8000,
      });
    } finally {
      this.sending.set(false);
    }
  }

  /**
   * Navigates to the email detail page for the most recently queued test send.
   * Called by the "View in queue" link rendered after a successful send.
   */
  viewLastSentEmail(): void {
    const id = this.lastSentEmailId();
    if (id !== null) {
      this.router.navigate(['/admin/emails', id]);
    }
  }

  /**
   * Converts a Date object to a YYYY-MM-DD string using local date parts
   * (not UTC) so that midnight local time does not shift to the previous day.
   */
  private toDateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Extracts a human-readable message from an HTTP error response or a
   * generic Error object, falling back to a generic string.
   * Surfaces the backend's validation message verbatim when available.
   */
  private extractErrorMessage(err: unknown): string {
    if (err && typeof err === 'object') {
      const httpErr = err as { error?: { message?: string | string[] }; message?: string };
      if (httpErr.error?.message) {
        const msg = httpErr.error.message;
        return Array.isArray(msg) ? msg.join(' ') : msg;
      }
      if (httpErr.message) {
        return httpErr.message;
      }
    }
    return 'An unexpected error occurred. Please try again.';
  }
}
