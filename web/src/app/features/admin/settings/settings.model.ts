/**
 * Shape of the system settings object returned by GET /settings and PATCH /settings.
 */
export interface SystemSettings {
  emailEnabled: boolean;
  deadlineEnabled: boolean;
  /** ISO date string (YYYY-MM-DD) or null when no deadline has been set. */
  deadlineDate: string | null;
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
}
