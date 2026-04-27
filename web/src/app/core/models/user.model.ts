/**
 * Represents an authenticated PRMS user returned from the API.
 *
 * Roles:
 *  - admin           — full platform access, including user management
 *  - workflow_admin  — cross-center negotiation rights; sees all projects and the Needs Assistance queue
 *  - unit_admin      — PPU/PCU editor; can edit whitelisted project metadata regardless of lock state and republish snapshots
 *  - program_rep     — access scoped to their assigned program
 *  - center_rep      — access scoped to their assigned center
 *  - null            — user record exists but no role has been assigned yet
 */
export interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role:
    | 'admin'
    | 'workflow_admin'
    | 'unit_admin'
    | 'program_rep'
    | 'center_rep'
    | null;
  /** FK to programs table; null when the user has no program assignment. */
  programId: number | null;
  /** FK to centers table; null when the user has no center assignment. */
  centerId: number | null;
  isActive: boolean;
}

/**
 * Shape of the response body returned by POST /api/auth/callback.
 */
export interface AuthCallbackResponse {
  accessToken: string;
  user: User;
}

/**
 * Shape of the response body returned by GET /api/auth/login.
 * The API redirects the browser to the Cognito hosted-UI URL.
 */
export interface LoginUrlResponse {
  url: string;
}

/**
 * Shape of the response body returned by POST /api/auth/refresh.
 */
export interface RefreshResponse {
  accessToken: string;
}
