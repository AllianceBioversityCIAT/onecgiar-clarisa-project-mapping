import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ConfirmDialogModule } from 'primeng/confirmdialog';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { ToastModule } from 'primeng/toast';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';
import { ConfirmationService, MessageService } from 'primeng/api';

import { SettingsService } from './settings.service';
import { UpdateSettingsPayload } from './settings.model';
import { EmailsService } from '../emails/emails.service';
import { UsersService } from '../../users/services/users.service';
import { UserWithRelations } from '../../users/models/user-management.model';

/**
 * SettingsComponent — admin-only page for managing global system settings.
 *
 * Displays six card sections:
 *   1. Email Notifications — toggle to enable/disable the email module.
 *   2. Center Deadline notification — toggle + date picker for the center
 *      mapping deadline (drives the center reminder emails).
 *   3. Programs Deadline notification — toggle + date picker for the program
 *      mapping deadline (drives the program reminder emails).
 *   4. Center Notification of Updates — toggle + interval/window days + end date for
 *      the periodic digest sent to center reps listing recent project activity.
 *   5. Program Notification of Updates — same digest pattern for program reps,
 *      listing projects mapped to their program with recent negotiation activity.
 *   6. Send Test Email — enqueue a test email to a chosen active user to
 *      verify the email pipeline independently of the global toggle.
 *
 * On init the form is hydrated from GET /settings. On save, PATCH /settings is
 * called; the backend requires a date when a deadline is enabled (any calendar
 * date — past, today, or future). Server-side error messages are surfaced
 * verbatim in the error toast so the user sees the exact constraint violated.
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
    ConfirmDialogModule,
    DatePickerModule,
    InputNumberModule,
    MessageModule,
    SelectModule,
    ToastModule,
    ToggleSwitchModule,
    TooltipModule,
  ],
  providers: [MessageService, ConfirmationService],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly settingsService = inject(SettingsService);
  private readonly emailsService = inject(EmailsService);
  private readonly usersService = inject(UsersService);
  private readonly messageService = inject(MessageService);
  private readonly confirmationService = inject(ConfirmationService);
  private readonly router = inject(Router);

  /** Reactive form with the three editable settings fields. */
  form!: FormGroup;

  /** True while the initial GET /settings request is in flight. */
  readonly loading = signal(false);

  /** True while the PATCH /settings request is in flight. */
  readonly saving = signal(false);

  /** True while the POST /admin/emails/run-reminders request is in flight. */
  readonly runningReminders = signal(false);

  /** True while the POST /admin/emails/run-program-reminders request is in flight. */
  readonly runningProgramReminders = signal(false);

  /** True while the POST /admin/emails/run-update-digest request is in flight. */
  readonly runningUpdateDigest = signal(false);

  /** True while the POST /admin/emails/run-program-update-digest request is in flight. */
  readonly runningProgramUpdateDigest = signal(false);

  /**
   * ISO timestamp of the last update-digest run, loaded from settings on init.
   * Displayed as a "Last sent" hint beneath the "Run digest now" button.
   * Null when the digest has never been run.
   */
  readonly updateDigestLastRunAt = signal<string | null>(null);

  /**
   * ISO timestamp of the last program update-digest run, loaded from settings on init.
   * Displayed as a "Last sent" hint beneath the "Run program digest now" button.
   * Null when the program digest has never been run.
   */
  readonly programUpdateDigestLastRunAt = signal<string | null>(null);

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
   * Signal mirror of the form value — updated on every valueChanges emission.
   * Required so computed() can track it reactively.
   */
  private readonly formValues = signal<{
    emailEnabled: boolean;
    deadlineEnabled: boolean;
    deadlineDate: Date | null;
    programDeadlineEnabled: boolean;
    programDeadlineDate: Date | null;
    updateDigestEnabled: boolean;
    updateDigestIntervalDays: number;
    updateDigestWindowDays: number;
    updateDigestEndDate: Date | null;
    programUpdateDigestEnabled: boolean;
    programUpdateDigestIntervalDays: number;
    programUpdateDigestWindowDays: number;
    programUpdateDigestEndDate: Date | null;
  }>({
    emailEnabled: false,
    deadlineEnabled: false,
    deadlineDate: null,
    programDeadlineEnabled: false,
    programDeadlineDate: null,
    updateDigestEnabled: false,
    updateDigestIntervalDays: 2,
    updateDigestWindowDays: 2,
    updateDigestEndDate: null,
    programUpdateDigestEnabled: false,
    programUpdateDigestIntervalDays: 2,
    programUpdateDigestWindowDays: 2,
    programUpdateDigestEndDate: null,
  });

  ngOnInit(): void {
    this.form = this.fb.group({
      emailEnabled: [false],
      deadlineEnabled: [false],
      deadlineDate: [null as Date | null],
      programDeadlineEnabled: [false],
      programDeadlineDate: [null as Date | null],
      updateDigestEnabled: [false],
      updateDigestIntervalDays: [2],
      updateDigestWindowDays: [2],
      updateDigestEndDate: [null as Date | null],
      programUpdateDigestEnabled: [false],
      programUpdateDigestIntervalDays: [2],
      programUpdateDigestWindowDays: [2],
      programUpdateDigestEndDate: [null as Date | null],
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
      this.autoSaveDeadline({
        deadlineEnabled: enabled,
        deadlineDate: enabled ? (this.form.get('deadlineDate')!.value as Date | null) : null,
      });
    });

    // Auto-save when the date changes. Pass the fresh Date as a parameter — same
    // staleness reason as above.
    this.form.get('deadlineDate')!.valueChanges.subscribe((v: Date | string | null) => {
      if (!(v instanceof Date)) return;
      this.autoSaveDeadline({ deadlineEnabled: true, deadlineDate: v });
    });

    // Program deadline: same pattern as the center deadline above, against
    // the programDeadlineEnabled / programDeadlineDate controls.
    this.form.get('programDeadlineEnabled')!.valueChanges.subscribe((enabled: boolean) => {
      if (!enabled) {
        this.form.get('programDeadlineDate')!.setValue(null, { emitEvent: false });
      }
      this.autoSaveProgramDeadline({
        programDeadlineEnabled: enabled,
        programDeadlineDate: enabled
          ? (this.form.get('programDeadlineDate')!.value as Date | null)
          : null,
      });
    });

    this.form.get('programDeadlineDate')!.valueChanges.subscribe((v: Date | string | null) => {
      if (!(v instanceof Date)) return;
      this.autoSaveProgramDeadline({
        programDeadlineEnabled: true,
        programDeadlineDate: v,
      });
    });

    // Update digest: toggle auto-saves immediately; field changes debounce via
    // the same pattern as the deadline pickers above.
    this.form.get('updateDigestEnabled')!.valueChanges.subscribe((enabled: boolean) => {
      if (!enabled) {
        this.form.get('updateDigestEndDate')!.setValue(null, { emitEvent: false });
      }
      this.autoSaveUpdateDigest({
        updateDigestEnabled: enabled,
        updateDigestIntervalDays: this.form.get('updateDigestIntervalDays')!.value as number,
        updateDigestWindowDays: this.form.get('updateDigestWindowDays')!.value as number,
        updateDigestEndDate: enabled
          ? (this.form.get('updateDigestEndDate')!.value as Date | null)
          : null,
      });
    });

    this.form.get('updateDigestIntervalDays')!.valueChanges.subscribe((v: number | null) => {
      if (v === null || !this.form.get('updateDigestEnabled')!.value) return;
      this.autoSaveUpdateDigest({
        updateDigestEnabled: true,
        updateDigestIntervalDays: v,
        updateDigestWindowDays: this.form.get('updateDigestWindowDays')!.value as number,
        updateDigestEndDate: this.form.get('updateDigestEndDate')!.value as Date | null,
      });
    });

    this.form.get('updateDigestWindowDays')!.valueChanges.subscribe((v: number | null) => {
      if (v === null || !this.form.get('updateDigestEnabled')!.value) return;
      this.autoSaveUpdateDigest({
        updateDigestEnabled: true,
        updateDigestIntervalDays: this.form.get('updateDigestIntervalDays')!.value as number,
        updateDigestWindowDays: v,
        updateDigestEndDate: this.form.get('updateDigestEndDate')!.value as Date | null,
      });
    });

    this.form.get('updateDigestEndDate')!.valueChanges.subscribe((v: Date | string | null) => {
      if (!(v instanceof Date)) return;
      this.autoSaveUpdateDigest({
        updateDigestEnabled: true,
        updateDigestIntervalDays: this.form.get('updateDigestIntervalDays')!.value as number,
        updateDigestWindowDays: this.form.get('updateDigestWindowDays')!.value as number,
        updateDigestEndDate: v,
      });
    });

    // Program update digest: toggle auto-saves immediately; field changes debounce
    // via the same pattern as the center update digest above.
    this.form.get('programUpdateDigestEnabled')!.valueChanges.subscribe((enabled: boolean) => {
      if (!enabled) {
        this.form.get('programUpdateDigestEndDate')!.setValue(null, { emitEvent: false });
      }
      this.autoSaveProgramUpdateDigest({
        programUpdateDigestEnabled: enabled,
        programUpdateDigestIntervalDays: this.form.get('programUpdateDigestIntervalDays')!
          .value as number,
        programUpdateDigestWindowDays: this.form.get('programUpdateDigestWindowDays')!
          .value as number,
        programUpdateDigestEndDate: enabled
          ? (this.form.get('programUpdateDigestEndDate')!.value as Date | null)
          : null,
      });
    });

    this.form.get('programUpdateDigestIntervalDays')!.valueChanges.subscribe((v: number | null) => {
      if (v === null || !this.form.get('programUpdateDigestEnabled')!.value) return;
      this.autoSaveProgramUpdateDigest({
        programUpdateDigestEnabled: true,
        programUpdateDigestIntervalDays: v,
        programUpdateDigestWindowDays: this.form.get('programUpdateDigestWindowDays')!
          .value as number,
        programUpdateDigestEndDate: this.form.get('programUpdateDigestEndDate')!
          .value as Date | null,
      });
    });

    this.form.get('programUpdateDigestWindowDays')!.valueChanges.subscribe((v: number | null) => {
      if (v === null || !this.form.get('programUpdateDigestEnabled')!.value) return;
      this.autoSaveProgramUpdateDigest({
        programUpdateDigestEnabled: true,
        programUpdateDigestIntervalDays: this.form.get('programUpdateDigestIntervalDays')!
          .value as number,
        programUpdateDigestWindowDays: v,
        programUpdateDigestEndDate: this.form.get('programUpdateDigestEndDate')!
          .value as Date | null,
      });
    });

    this.form
      .get('programUpdateDigestEndDate')!
      .valueChanges.subscribe((v: Date | string | null) => {
        if (!(v instanceof Date)) return;
        this.autoSaveProgramUpdateDigest({
          programUpdateDigestEnabled: true,
          programUpdateDigestIntervalDays: this.form.get('programUpdateDigestIntervalDays')!
            .value as number,
          programUpdateDigestWindowDays: this.form.get('programUpdateDigestWindowDays')!
            .value as number,
          programUpdateDigestEndDate: v,
        });
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
   * Any stored date (past, today, or future) is patched in as-is.
   */
  private async loadSettings(): Promise<void> {
    this.loading.set(true);
    try {
      const settings = await firstValueFrom(this.settingsService.getSettings());

      // Convert ISO date strings to Date objects for the p-datepicker bindings.
      const deadlineDateValue = settings.deadlineDate ? new Date(settings.deadlineDate) : null;
      const programDeadlineDateValue = settings.programDeadlineDate
        ? new Date(settings.programDeadlineDate)
        : null;
      const updateDigestEndDateValue = settings.updateDigestEndDate
        ? new Date(settings.updateDigestEndDate)
        : null;
      const programUpdateDigestEndDateValue = settings.programUpdateDigestEndDate
        ? new Date(settings.programUpdateDigestEndDate)
        : null;

      // Store the read-only last-run timestamps for display.
      this.updateDigestLastRunAt.set(settings.updateDigestLastRunAt ?? null);
      this.programUpdateDigestLastRunAt.set(settings.programUpdateDigestLastRunAt ?? null);

      // emitEvent: false prevents the valueChanges subscriptions from firing a
      // premature auto-save during initial hydration.
      this.form.patchValue(
        {
          emailEnabled: settings.emailEnabled,
          deadlineEnabled: settings.deadlineEnabled,
          deadlineDate: deadlineDateValue,
          programDeadlineEnabled: settings.programDeadlineEnabled,
          programDeadlineDate: programDeadlineDateValue,
          updateDigestEnabled: settings.updateDigestEnabled,
          updateDigestIntervalDays: settings.updateDigestIntervalDays,
          updateDigestWindowDays: settings.updateDigestWindowDays,
          updateDigestEndDate: updateDigestEndDateValue,
          programUpdateDigestEnabled: settings.programUpdateDigestEnabled,
          programUpdateDigestIntervalDays: settings.programUpdateDigestIntervalDays,
          programUpdateDigestWindowDays: settings.programUpdateDigestWindowDays,
          programUpdateDigestEndDate: programUpdateDigestEndDateValue,
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

    const payload: UpdateSettingsPayload = {
      emailEnabled: enabled,
      ...this.centerDeadlinePayload(),
      ...this.programDeadlinePayload(),
      ...this.updateDigestPayload(),
      ...this.programUpdateDigestPayload(),
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
   *    Any calendar date is accepted (no future-date restriction).
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
    // Any calendar date is accepted, so there is no future-date guard.
    if (vals.deadlineEnabled && !vals.deadlineDate) {
      return;
    }

    this.saving.set(true);
    try {
      const payload: UpdateSettingsPayload = {
        emailEnabled: vals.emailEnabled,
        deadlineEnabled: vals.deadlineEnabled,
        deadlineDate:
          vals.deadlineEnabled && vals.deadlineDate ? this.toDateString(vals.deadlineDate) : null,
        // The program deadline and digest settings are not edited in this stream;
        // carry their current form values so the PATCH never resets them.
        ...this.programDeadlinePayload(),
        ...this.updateDigestPayload(),
        ...this.programUpdateDigestPayload(),
      };

      await firstValueFrom(this.settingsService.updateSettings(payload));
      this.messageService.add({
        severity: 'success',
        summary: vals.deadlineEnabled ? 'Center deadline updated' : 'Center deadline disabled',
        detail: vals.deadlineEnabled
          ? `Center deadline set to ${this.toDateString(vals.deadlineDate!)}.`
          : 'Center mapping deadline has been disabled.',
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
   * Immediately persists the program-deadline settings when either the
   * programDeadlineEnabled toggle or the programDeadlineDate picker changes.
   * Mirrors {@link autoSaveDeadline} for the program deadline; the same
   * guards (in-flight save, missing date) apply. The center
   * deadline is carried forward from its current form value so the PATCH
   * never resets it.
   */
  private async autoSaveProgramDeadline(fresh: {
    programDeadlineEnabled: boolean;
    programDeadlineDate: Date | null;
  }): Promise<void> {
    if (this.saving()) return;

    const enabled = fresh.programDeadlineEnabled;
    const date = fresh.programDeadlineDate;

    // Guard: enabled but no date selected yet — wait for the user.
    // Any calendar date is accepted, so there is no future-date guard.
    if (enabled && !date) {
      return;
    }

    this.saving.set(true);
    try {
      const payload: UpdateSettingsPayload = {
        emailEnabled: this.form.get('emailEnabled')!.value as boolean,
        // The center deadline and digest settings are not edited in this stream;
        // carry their current form values so the PATCH never resets them.
        ...this.centerDeadlinePayload(),
        programDeadlineEnabled: enabled,
        programDeadlineDate: enabled && date ? this.toDateString(date) : null,
        ...this.updateDigestPayload(),
        ...this.programUpdateDigestPayload(),
      };

      await firstValueFrom(this.settingsService.updateSettings(payload));
      this.messageService.add({
        severity: 'success',
        summary: enabled ? 'Program deadline updated' : 'Program deadline disabled',
        detail: enabled
          ? `Program deadline set to ${this.toDateString(date!)}.`
          : 'Program mapping deadline has been disabled.',
        life: 3000,
      });
    } catch (err: unknown) {
      const detail = this.extractErrorMessage(err);
      this.messageService.add({
        severity: 'error',
        summary: 'Failed to save program deadline',
        detail,
        life: 5000,
      });
      await this.loadSettings();
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Current center-deadline payload fields, read from the form controls.
   * Reading per-control values is reliable (Angular sets a control's value
   * before its valueChanges fires); only the aggregate `form.value` lags.
   */
  private centerDeadlinePayload(): Pick<UpdateSettingsPayload, 'deadlineEnabled' | 'deadlineDate'> {
    const enabled = this.form.get('deadlineEnabled')!.value as boolean;
    const date = this.form.get('deadlineDate')!.value as Date | null;
    return {
      deadlineEnabled: enabled,
      deadlineDate: enabled && date ? this.toDateString(date) : null,
    };
  }

  /** Current program-deadline payload fields, read from the form controls. */
  private programDeadlinePayload(): Pick<
    UpdateSettingsPayload,
    'programDeadlineEnabled' | 'programDeadlineDate'
  > {
    const enabled = this.form.get('programDeadlineEnabled')!.value as boolean;
    const date = this.form.get('programDeadlineDate')!.value as Date | null;
    return {
      programDeadlineEnabled: enabled,
      programDeadlineDate: enabled && date ? this.toDateString(date) : null,
    };
  }

  /** Current update-digest payload fields, read from the form controls. */
  private updateDigestPayload(): Pick<
    UpdateSettingsPayload,
    | 'updateDigestEnabled'
    | 'updateDigestIntervalDays'
    | 'updateDigestWindowDays'
    | 'updateDigestEndDate'
  > {
    const enabled = this.form.get('updateDigestEnabled')!.value as boolean;
    const intervalDays = this.form.get('updateDigestIntervalDays')!.value as number;
    const windowDays = this.form.get('updateDigestWindowDays')!.value as number;
    const endDate = this.form.get('updateDigestEndDate')!.value as Date | null;
    return {
      updateDigestEnabled: enabled,
      updateDigestIntervalDays: intervalDays,
      updateDigestWindowDays: windowDays,
      updateDigestEndDate: enabled && endDate ? this.toDateString(endDate) : null,
    };
  }

  /** Current program-update-digest payload fields, read from the form controls. */
  private programUpdateDigestPayload(): Pick<
    UpdateSettingsPayload,
    | 'programUpdateDigestEnabled'
    | 'programUpdateDigestIntervalDays'
    | 'programUpdateDigestWindowDays'
    | 'programUpdateDigestEndDate'
  > {
    const enabled = this.form.get('programUpdateDigestEnabled')!.value as boolean;
    const intervalDays = this.form.get('programUpdateDigestIntervalDays')!.value as number;
    const windowDays = this.form.get('programUpdateDigestWindowDays')!.value as number;
    const endDate = this.form.get('programUpdateDigestEndDate')!.value as Date | null;
    return {
      programUpdateDigestEnabled: enabled,
      programUpdateDigestIntervalDays: intervalDays,
      programUpdateDigestWindowDays: windowDays,
      programUpdateDigestEndDate: enabled && endDate ? this.toDateString(endDate) : null,
    };
  }

  /**
   * Immediately persists the update-digest settings when any of its controls
   * change (toggle, interval days, window days, or end date).
   *
   * Guards:
   *  - Skips silently if another save is already in flight.
   *  - When the toggle is on, skips if either day field is null/invalid
   *    (the p-inputnumber prevents this in practice, but guard defensively).
   *  - When the toggle is on, skips until an end date is picked (the backend
   *    requires it — same wait-for-input behavior as the deadline cards).
   *
   * On error, re-fetches from the server to revert the form.
   */
  private async autoSaveUpdateDigest(fresh: {
    updateDigestEnabled: boolean;
    updateDigestIntervalDays: number;
    updateDigestWindowDays: number;
    updateDigestEndDate: Date | null;
  }): Promise<void> {
    if (this.saving()) return;

    const {
      updateDigestEnabled: enabled,
      updateDigestIntervalDays: intervalDays,
      updateDigestWindowDays: windowDays,
      updateDigestEndDate: endDate,
    } = fresh;

    // Guard: day fields must be valid positive numbers when the digest is enabled.
    if (enabled && (!intervalDays || intervalDays < 1 || !windowDays || windowDays < 1)) {
      return;
    }

    // Guard: enabled but no end date selected yet — wait for the user. The
    // backend requires an end date when the digest is enabled, so enabling the
    // toggle persists nothing until a stop date is picked (mirrors the
    // deadline cards). The inline warning prompts the user to set one.
    if (enabled && !endDate) {
      return;
    }

    this.saving.set(true);
    try {
      const payload: UpdateSettingsPayload = {
        emailEnabled: this.form.get('emailEnabled')!.value as boolean,
        ...this.centerDeadlinePayload(),
        ...this.programDeadlinePayload(),
        updateDigestEnabled: enabled,
        updateDigestIntervalDays: intervalDays,
        updateDigestWindowDays: windowDays,
        updateDigestEndDate: enabled && endDate ? this.toDateString(endDate) : null,
        ...this.programUpdateDigestPayload(),
      };

      await firstValueFrom(this.settingsService.updateSettings(payload));
      this.messageService.add({
        severity: 'success',
        summary: enabled ? 'Update digest settings saved' : 'Update digest disabled',
        detail: enabled
          ? `Digest will be sent every ${intervalDays} day(s), including updates from the last ${windowDays} day(s).`
          : 'Center Notification of Updates digest has been disabled.',
        life: 3000,
      });
    } catch (err: unknown) {
      const detail = this.extractErrorMessage(err);
      this.messageService.add({
        severity: 'error',
        summary: 'Failed to save digest settings',
        detail,
        life: 5000,
      });
      await this.loadSettings();
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Immediately persists the program update-digest settings when any of its
   * controls change (toggle, interval days, window days, or end date).
   *
   * Guards:
   *  - Skips silently if another save is already in flight.
   *  - When the toggle is on, skips if either day field is null/invalid.
   *  - When the toggle is on, skips until an end date is picked (the backend
   *    requires it — same wait-for-input behavior as the center digest card).
   *
   * On error, re-fetches from the server to revert the form.
   */
  private async autoSaveProgramUpdateDigest(fresh: {
    programUpdateDigestEnabled: boolean;
    programUpdateDigestIntervalDays: number;
    programUpdateDigestWindowDays: number;
    programUpdateDigestEndDate: Date | null;
  }): Promise<void> {
    if (this.saving()) return;

    const {
      programUpdateDigestEnabled: enabled,
      programUpdateDigestIntervalDays: intervalDays,
      programUpdateDigestWindowDays: windowDays,
      programUpdateDigestEndDate: endDate,
    } = fresh;

    // Guard: day fields must be valid positive numbers when the digest is enabled.
    if (enabled && (!intervalDays || intervalDays < 1 || !windowDays || windowDays < 1)) {
      return;
    }

    // Guard: enabled but no end date selected yet — wait for the user. The
    // backend requires an end date when the digest is enabled, so enabling the
    // toggle persists nothing until a stop date is picked.
    if (enabled && !endDate) {
      return;
    }

    this.saving.set(true);
    try {
      const payload: UpdateSettingsPayload = {
        emailEnabled: this.form.get('emailEnabled')!.value as boolean,
        ...this.centerDeadlinePayload(),
        ...this.programDeadlinePayload(),
        ...this.updateDigestPayload(),
        programUpdateDigestEnabled: enabled,
        programUpdateDigestIntervalDays: intervalDays,
        programUpdateDigestWindowDays: windowDays,
        programUpdateDigestEndDate: enabled && endDate ? this.toDateString(endDate) : null,
      };

      await firstValueFrom(this.settingsService.updateSettings(payload));
      this.messageService.add({
        severity: 'success',
        summary: enabled
          ? 'Program update digest settings saved'
          : 'Program update digest disabled',
        detail: enabled
          ? `Program digest will be sent every ${intervalDays} day(s), including updates from the last ${windowDays} day(s).`
          : 'Program Notification of Updates digest has been disabled.',
        life: 3000,
      });
    } catch (err: unknown) {
      const detail = this.extractErrorMessage(err);
      this.messageService.add({
        severity: 'error',
        summary: 'Failed to save program digest settings',
        detail,
        life: 5000,
      });
      await this.loadSettings();
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Opens a confirm dialog before manually running the update-digest
   * generation (POST /admin/emails/run-update-digest). Mirrors
   * {@link confirmRunReminders} for the digest side.
   */
  confirmRunUpdateDigest(): void {
    this.confirmationService.confirm({
      header: 'Run update digest now?',
      message:
        'Send a digest of recent project updates to all center reps now, bypassing the configured ' +
        'sending interval. Centers with no qualifying updates or no active reps are skipped, and ' +
        'anyone already sent a digest today will not receive another. Queued emails are delivered ' +
        'on the next dispatch run (subject to the global email toggle).',
      icon: 'pi pi-send',
      acceptLabel: 'Run now',
      rejectLabel: 'Cancel',
      accept: () => this.executeRunUpdateDigest(),
    });
  }

  private executeRunUpdateDigest(): void {
    this.runningUpdateDigest.set(true);
    this.emailsService.runUpdateDigest().subscribe({
      next: (res) => {
        this.runningUpdateDigest.set(false);
        let severity: 'success' | 'info' | 'warn' = 'info';
        let summary = 'No digests queued';
        if (res.enqueued > 0) {
          severity = 'success';
          summary = 'Digest emails queued';
        } else if (res.shortCircuit === 'error') {
          severity = 'warn';
          summary = 'Digest run incomplete';
        }
        this.messageService.add({ severity, summary, detail: res.message, life: 7000 });
      },
      error: (err: unknown) => {
        this.runningUpdateDigest.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Digest run failed',
          detail: this.extractErrorMessage(err),
          life: 8000,
        });
      },
    });
  }

  /**
   * Opens a confirm dialog before manually running the program update-digest
   * generation (POST /admin/emails/run-program-update-digest). Mirrors
   * {@link confirmRunUpdateDigest} for the program side.
   */
  confirmRunProgramUpdateDigest(): void {
    this.confirmationService.confirm({
      header: 'Run program update digest now?',
      message:
        'Send a digest of recent project updates to all program reps now, bypassing the configured ' +
        'sending interval. Programs with no qualifying updates or no active reps are skipped, and ' +
        'anyone already sent a digest today will not receive another. Queued emails are delivered ' +
        'on the next dispatch run (subject to the global email toggle).',
      icon: 'pi pi-send',
      acceptLabel: 'Run now',
      rejectLabel: 'Cancel',
      accept: () => this.executeRunProgramUpdateDigest(),
    });
  }

  private executeRunProgramUpdateDigest(): void {
    this.runningProgramUpdateDigest.set(true);
    this.emailsService.runProgramUpdateDigest().subscribe({
      next: (res) => {
        this.runningProgramUpdateDigest.set(false);
        let severity: 'success' | 'info' | 'warn' = 'info';
        let summary = 'No digests queued';
        if (res.enqueued > 0) {
          severity = 'success';
          summary = 'Digest emails queued';
        } else if (res.shortCircuit === 'error') {
          severity = 'warn';
          summary = 'Digest run incomplete';
        }
        this.messageService.add({ severity, summary, detail: res.message, life: 7000 });
      },
      error: (err: unknown) => {
        this.runningProgramUpdateDigest.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Digest run failed',
          detail: this.extractErrorMessage(err),
          life: 8000,
        });
      },
    });
  }

  /**
   * Formats an ISO timestamp for display in the "Last sent" hint.
   * Returns a locale-aware date+time string, or null if the input is falsy.
   */
  formatLastRunAt(iso: string | null): string | null {
    if (!iso) return null;
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
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
   * Opens a confirm dialog before manually running the center mapping-reminder
   * generation (POST /admin/emails/run-reminders, force mode). Confirm first,
   * then execute — same pattern as the email-management page this moved from.
   */
  confirmRunReminders(): void {
    this.confirmationService.confirm({
      header: 'Run center reminders now?',
      message:
        'Generate center mapping-progress reminder emails now, bypassing the weekly (Monday) schedule. ' +
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
        //  - rows queued  → success
        //  - tick errored → warn (nothing queued, but not a clean no-op)
        //  - benign no-op → info (e.g. deadline not set, all centers at target)
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
      },
      error: (err: unknown) => {
        this.runningReminders.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Reminder run failed',
          detail: this.extractErrorMessage(err),
          life: 8000,
        });
      },
    });
  }

  /**
   * Opens a confirm dialog before manually running the program mapping-reminder
   * generation (POST /admin/emails/run-program-reminders). Confirm first, then
   * execute — mirrors {@link confirmRunReminders} for the program side.
   */
  confirmRunProgramReminders(): void {
    this.confirmationService.confirm({
      header: 'Run program reminders now?',
      message:
        'Generate program mapping-reminder emails now. Programs with no mappings awaiting a ' +
        'response or with no active reps are skipped, and anyone already reminded today will not ' +
        'be emailed again. Queued reminders are sent on the next dispatch run (subject to the ' +
        'global email toggle).',
      icon: 'pi pi-send',
      acceptLabel: 'Run now',
      rejectLabel: 'Cancel',
      accept: () => this.executeRunProgramReminders(),
    });
  }

  private executeRunProgramReminders(): void {
    this.runningProgramReminders.set(true);
    this.emailsService.runProgramReminders().subscribe({
      next: (res) => {
        this.runningProgramReminders.set(false);
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
      },
      error: (err: unknown) => {
        this.runningProgramReminders.set(false);
        this.messageService.add({
          severity: 'error',
          summary: 'Reminder run failed',
          detail: this.extractErrorMessage(err),
          life: 8000,
        });
      },
    });
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
