import { Center, Program } from './reference-data.model';

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
  role: 'admin' | 'workflow_admin' | 'unit_admin' | 'program_rep' | 'center_rep' | null;
  /** FK to programs table; null when the user has no program assignment. */
  programId: number | null;
  /**
   * Ordered list of program IDs assigned to this user (primary first).
   * Empty array for all non-program-rep roles.
   * Multi-program reps have 2+ entries; single-program reps have exactly 1.
   */
  programIds: number[];
  /**
   * Full Program objects corresponding to programIds, in the same sort order.
   * Empty array for all non-program-rep roles.
   */
  programs: Program[];
  /** Primary center FK; null when the user has no center assignment. */
  centerId: number | null;
  /**
   * Ordered list of center IDs assigned to this user (primary first).
   * Empty array for all non-center-rep roles.
   * Multi-center reps have 2+ entries; single-center reps have exactly 1.
   */
  centerIds: number[];
  /**
   * Full Center objects corresponding to centerIds, in the same sort order.
   * Empty array for all non-center-rep roles.
   */
  centers: Center[];
  isActive: boolean;
  /**
   * Cognito subject identifier. `null` until the user signs in for the
   * first time — admin-created users start with `cognitoSub = null` and
   * the value is backfilled on first login. Admin UI uses this to decide
   * whether name fields are still editable.
   */
  cognitoSub: string | null;
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
