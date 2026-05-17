import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { MessageModule } from 'primeng/message';
import { ToastModule } from 'primeng/toast';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { MessageService } from 'primeng/api';

import { SettingsService } from './settings.service';
import { UpdateSettingsPayload } from './settings.model';

/**
 * SettingsComponent — admin-only page for managing global system settings.
 *
 * Displays two card sections:
 *   1. Email Notifications — toggle to enable/disable the email module.
 *   2. Mapping Deadline — toggle + date picker to set a future deadline for
 *      center reps to complete program mapping.
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
    ReactiveFormsModule,
    ButtonModule,
    CardModule,
    DatePickerModule,
    MessageModule,
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
  private readonly messageService = inject(MessageService);

  /** Reactive form with the three editable settings fields. */
  form!: FormGroup;

  /** True while the initial GET /settings request is in flight. */
  readonly loading = signal(false);

  /** True while the PATCH /settings request is in flight. */
  readonly saving = signal(false);

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
   * Derived save-button disabled state.
   * Disabled when:
   *   - a save is in progress, OR
   *   - the deadline is enabled but no date has been selected.
   */
  readonly saveDisabled = computed(() => {
    if (this.saving()) return true;
    // Access form values reactively via the signal wrapper updated on valueChanges.
    const vals = this.formValues();
    if (vals.deadlineEnabled && !vals.deadlineDate) return true;
    return false;
  });

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

    // When the deadline toggle is turned off, clear the date picker.
    this.form.get('deadlineEnabled')!.valueChanges.subscribe((enabled: boolean) => {
      if (!enabled) {
        this.form.get('deadlineDate')!.setValue(null);
      }
    });

    this.loadSettings();
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

      this.form.patchValue({
        emailEnabled: settings.emailEnabled,
        deadlineEnabled: settings.deadlineEnabled,
        deadlineDate: deadlineDateValue,
      });
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
   * Submits the current form values to PATCH /settings.
   * Converts the Date picker value back to a YYYY-MM-DD string for the API.
   * Backend error messages are extracted and shown verbatim in the toast.
   */
  async save(): Promise<void> {
    if (this.saveDisabled()) return;

    const raw = this.form.getRawValue();
    const payload: UpdateSettingsPayload = {
      emailEnabled: raw.emailEnabled,
      deadlineEnabled: raw.deadlineEnabled,
      deadlineDate: raw.deadlineDate ? this.toDateString(raw.deadlineDate as Date) : null,
    };

    this.saving.set(true);
    try {
      await firstValueFrom(this.settingsService.updateSettings(payload));
      this.messageService.add({
        severity: 'success',
        summary: 'Settings saved',
        detail: 'System settings have been updated successfully.',
        life: 4000,
      });
    } catch (err: unknown) {
      const detail = this.extractErrorMessage(err);
      this.messageService.add({
        severity: 'error',
        summary: 'Save failed',
        detail,
        life: 8000,
      });
    } finally {
      this.saving.set(false);
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
