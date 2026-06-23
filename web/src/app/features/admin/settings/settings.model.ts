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
}
