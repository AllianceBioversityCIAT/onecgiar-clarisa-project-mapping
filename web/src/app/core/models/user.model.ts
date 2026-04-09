/**
 * Represents an authenticated PRMS user returned from the API.
 *
 * Roles:
 *  - admin        — full platform access, including user management
 *  - program_rep  — access scoped to their assigned program
 *  - center_rep   — access scoped to their assigned center
 *  - null         — user record exists but no role has been assigned yet
 */
export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'admin' | 'program_rep' | 'center_rep' | null;
  programId: string | null;
  centerId: string | null;
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
