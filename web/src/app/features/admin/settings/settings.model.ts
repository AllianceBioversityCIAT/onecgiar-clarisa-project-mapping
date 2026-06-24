/**
 * Shape of the system settings object returned by GET /settings and PATCH /settings.
 */
export interface SystemSettings {
  emailEnabled: boolean;
  /** Center mapping deadline toggle (drives the center reminder emails). */
  deadlineEnabled: boolean;
  /** ISO date string (YYYY-MM-DD) or null when no center deadline is set. */
  deadlineDate: string | null;
  /** Program mapping deadline toggle (drives the program reminder emails). */
  programDeadlineEnabled: boolean;
  /** ISO date string (YYYY-MM-DD) or null when no program deadline is set. */
  programDeadlineDate: string | null;
  /** Toggle for the notification-of-updates digest emails to center reps. */
  updateDigestEnabled: boolean;
  /** How often (in days) the digest is sent to each center. 1–90. */
  updateDigestIntervalDays: number;
  /** How many days back to look for project updates to include in the digest. 1–90. */
  updateDigestWindowDays: number;
  /** ISO date string (YYYY-MM-DD) after which digest sending stops, or null. */
  updateDigestEndDate: string | null;
  /** ISO timestamp of the last digest run, or null if never run. READ-ONLY — never send in PATCH. */
  updateDigestLastRunAt: string | null;
  /** Toggle for the notification-of-updates digest emails to program reps. */
  programUpdateDigestEnabled: boolean;
  /** How often (in days) the program digest is sent. 1–90. */
  programUpdateDigestIntervalDays: number;
  /** How many days back to look for project updates to include in the program digest. 1–90. */
  programUpdateDigestWindowDays: number;
  /** ISO date string (YYYY-MM-DD) after which program digest sending stops, or null. */
  programUpdateDigestEndDate: string | null;
  /** ISO timestamp of the last program digest run, or null if never run. READ-ONLY — never send in PATCH. */
  programUpdateDigestLastRunAt: string | null;
  /** ISO timestamp of the last update. */
  updatedAt: string;
  /** ID of the user who last saved settings, or null if never saved. */
  updatedBy: number | null;
}

/**
 * Payload sent to PATCH /settings.
 * deadlineDate is required (and must be a future date) when deadlineEnabled is true.
 */
export interface UpdateSettingsPayload {
  emailEnabled: boolean;
  deadlineEnabled: boolean;
  deadlineDate?: string | null;
  programDeadlineEnabled: boolean;
  programDeadlineDate?: string | null;
  updateDigestEnabled: boolean;
  updateDigestIntervalDays: number;
  updateDigestWindowDays: number;
  updateDigestEndDate?: string | null;
  programUpdateDigestEnabled: boolean;
  programUpdateDigestIntervalDays: number;
  programUpdateDigestWindowDays: number;
  programUpdateDigestEndDate?: string | null;
}
