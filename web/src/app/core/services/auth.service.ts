import { Injectable, inject, signal, computed } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import {
  User,
  AuthCallbackResponse,
  LoginUrlResponse,
  RefreshResponse,
} from '../models/user.model';
import { Center, Program } from '../models/reference-data.model';

/**
 * sessionStorage key used to round-trip the URL the user was trying to
 * reach when an unauthenticated request kicked them to the login flow.
 * Read by AuthCallbackComponent after Cognito returns to the app.
 */
const RETURN_URL_KEY = 'prms.auth.returnUrl';

/**
 * localStorage key used to persist the active center selection for
 * multi-center center_rep users across page refreshes.
 */
const ACTIVE_CENTER_STORAGE_KEY = 'prms.activeCenterId';

/**
 * localStorage key used to persist the active program selection for
 * multi-program program_rep users across page refreshes.
 */
const ACTIVE_PROGRAM_STORAGE_KEY = 'prms.activeProgramId';

/**
 * AuthService — manages the Cognito OAuth2 session for the application.
 *
 * Security model:
 *  - The short-lived JWT access token is stored only in memory (a signal).
 *    It is never written to localStorage or sessionStorage.
 *  - The long-lived refresh token lives in an httpOnly cookie managed
 *    entirely by the API. Angular never reads or writes that cookie.
 *
 * Session recovery:
 *  On service construction, loadUser() is called immediately. If a valid
 *  refresh cookie is present the API returns the user profile, which
 *  silently restores the session without requiring a new login.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------

  /** The currently authenticated user, or null when not logged in. */
  readonly currentUser = signal<User | null>(null);

  /**
   * The short-lived JWT access token held in memory only.
   * Exposed via getAccessToken() for the HTTP interceptor.
   */
  private readonly accessToken = signal<string | null>(null);

  /**
   * The active center ID selected by a multi-center center_rep.
   * Initialized from localStorage on construction; validated/corrected
   * every time the user signal changes via validateActiveCenter().
   * Always null for non-center-rep roles and single-center reps.
   */
  private readonly _activeCenterId = signal<number | null>(this.loadPersistedActiveCenter());

  /** Read-only projection of the active center ID (consumed by auth interceptor and CenterSwitcherComponent). */
  readonly activeCenterId = this._activeCenterId.asReadonly();

  /**
   * The active program ID selected by a multi-program program_rep.
   * Initialized from localStorage on construction; validated/corrected
   * every time the user signal changes via validateActiveProgram().
   * Always null for non-program-rep roles and single-program reps.
   */
  private readonly _activeProgramId = signal<number | null>(this.loadPersistedActiveProgram());

  /** Read-only projection of the active program ID (consumed by auth interceptor and ProgramSwitcherComponent). */
  readonly activeProgramId = this._activeProgramId.asReadonly();

  // -----------------------------------------------------------------------
  // Derived computed signals
  // -----------------------------------------------------------------------

  /** True when a user is actively logged in. */
  readonly isAuthenticated = computed(() => !!this.currentUser());

  /** True when the logged-in user has the 'admin' role. */
  readonly isAdmin = computed(() => this.currentUser()?.role === 'admin');

  /** True when the logged-in user has the 'workflow_admin' role. */
  readonly isWorkflowAdmin = computed(() => this.currentUser()?.role === 'workflow_admin');

  /** True when the logged-in user has the 'unit_admin' (PPU/PCU) role. */
  readonly isUnitAdmin = computed(() => this.currentUser()?.role === 'unit_admin');

  /**
   * True when the user is either admin or workflow_admin.
   * Use this to gate features that both roles share (e.g. Needs Assistance queue,
   * cross-center negotiation actions, project-wide visibility).
   */
  readonly isAdminOrWorkflowAdmin = computed(() => this.isAdmin() || this.isWorkflowAdmin());

  /** True when the logged-in user has the 'program_rep' role. */
  readonly isProgramRep = computed(() => this.currentUser()?.role === 'program_rep');

  /** True when the logged-in user has the 'center_rep' role. */
  readonly isCenterRep = computed(() => this.currentUser()?.role === 'center_rep');

  /**
   * The resolved Center object for the currently active center.
   * Falls back to the primary centerId when no explicit selection exists
   * (covers single-center reps who never open the switcher).
   * Returns null for non-center-rep roles.
   */
  readonly activeCenter = computed<Center | null>(() => {
    const id = this._activeCenterId() ?? this.currentUser()?.centerId ?? null;
    if (id == null) return null;
    return this.currentUser()?.centers.find((c) => c.id === id) ?? null;
  });

  /**
   * The effective center ID to attach as X-Active-Center on outgoing API
   * calls and consumed by all downstream feature components.
   * For multi-center reps this is the explicitly chosen center; for
   * single-center reps it is the sole centerId; for all other roles it is null.
   */
  readonly effectiveCenterId = computed<number | null>(() => {
    return this._activeCenterId() ?? this.currentUser()?.centerId ?? null;
  });

  /**
   * The resolved Program object for the currently active program.
   * Falls back to the primary programId when no explicit selection exists
   * (covers single-program reps who never open the switcher).
   * Returns null for non-program-rep roles.
   */
  readonly activeProgram = computed<Program | null>(() => {
    const id = this._activeProgramId() ?? this.currentUser()?.programId ?? null;
    if (id == null) return null;
    return this.currentUser()?.programs.find((p) => p.id === id) ?? null;
  });

  /**
   * The effective program ID to attach as X-Active-Program on outgoing API
   * calls and consumed by all downstream feature components.
   * For multi-program reps this is the explicitly chosen program; for
   * single-program reps it is the sole programId; for all other roles it is null.
   */
  readonly effectiveProgramId = computed<number | null>(() => {
    return this._activeProgramId() ?? this.currentUser()?.programId ?? null;
  });

  // -----------------------------------------------------------------------
  // Constructor — attempt silent session recovery on app start
  // -----------------------------------------------------------------------

  /**
   * Promise that resolves once the initial session recovery attempt
   * (loadUser) has completed. Guards and other consumers must await
   * this before checking isAuthenticated() to avoid race conditions.
   */
  readonly initialized: Promise<void>;

  constructor() {
    // Attempt to restore the session from an existing refresh cookie.
    // Store the promise so guards can await it before checking auth state.
    this.initialized = this.loadUser();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Returns the current in-memory access token.
   * Called by the AuthInterceptor to attach the Authorization header.
   */
  getAccessToken(): string | null {
    return this.accessToken();
  }

  /**
   * Fetches the Cognito hosted-UI login URL from the API and redirects
   * the browser there, initiating the OAuth2 authorization code flow.
   */
  async login(): Promise<void> {
    try {
      const { url } = await firstValueFrom(this.api.get<LoginUrlResponse>('/auth/login'));
      window.location.href = url;
    } catch {
      // If the API is unreachable the user stays on the current page.
      // A toast or global error handler will surface the problem.
    }
  }

  /**
   * Stash the URL the user was trying to reach so AuthCallbackComponent
   * can resume the journey after Cognito redirects back. Skips the auth
   * page itself and any path missing/clearly internal so we never bounce
   * the user back into the login flow.
   */
  rememberReturnUrl(url: string | null | undefined): void {
    if (!url) return;
    if (url.startsWith('/auth')) return;
    try {
      sessionStorage.setItem(RETURN_URL_KEY, url);
    } catch {
      // sessionStorage may be unavailable (private mode, SSR) — ignore.
    }
  }

  /**
   * Pop the saved return URL set by rememberReturnUrl(). Returns null
   * when nothing was stashed or the value looks unsafe.
   */
  consumeReturnUrl(): string | null {
    try {
      const url = sessionStorage.getItem(RETURN_URL_KEY);
      sessionStorage.removeItem(RETURN_URL_KEY);
      // Only honor same-origin paths to avoid open-redirect abuse.
      if (!url || !url.startsWith('/') || url.startsWith('//')) return null;
      if (url.startsWith('/auth')) return null;
      return url;
    } catch {
      return null;
    }
  }

  /**
   * Dev-only login bypassing Cognito. Calls the dev-token endpoint
   * which returns a JWT + sets a refresh cookie directly.
   */
  async devLogin(email: string): Promise<void> {
    const { accessToken, user } = await firstValueFrom(
      this.api.get<AuthCallbackResponse>(`/auth/dev-token?email=${encodeURIComponent(email)}`),
    );
    this.accessToken.set(accessToken);
    this.currentUser.set(user);
    this.validateActiveCenter();
    this.validateActiveProgram();
  }

  /**
   * Exchanges the OAuth2 authorization code (from the Cognito redirect)
   * for an access token and user profile. Stores both in memory signals.
   *
   * Called by AuthCallbackComponent after Cognito redirects back with ?code=…
   */
  async handleCallback(code: string): Promise<void> {
    const { accessToken, user } = await firstValueFrom(
      this.api.post<AuthCallbackResponse>('/auth/callback', { code }),
    );

    this.accessToken.set(accessToken);
    this.currentUser.set(user);
    this.validateActiveCenter();
    this.validateActiveProgram();
  }

  /**
   * Logs the user out.
   * Calls the API to invalidate the refresh cookie server-side, clears
   * all in-memory state, then redirects to the auth page.
   */
  async logout(): Promise<void> {
    let logoutUrl: string | undefined;
    try {
      const res = await firstValueFrom(
        this.api.post<{ message: string; logoutUrl?: string }>('/auth/logout'),
      );
      logoutUrl = res?.logoutUrl;
    } catch {
      // Even if the API call fails, clear client state and redirect.
    } finally {
      this.clearSession();
      if (logoutUrl) {
        // Redirect through Cognito's logout endpoint to clear its hosted-UI
        // session cookie; Cognito then returns the user to /auth. Without
        // this, the next login silently re-authenticates the same user.
        window.location.href = logoutUrl;
      } else {
        await this.router.navigate(['/auth']);
      }
    }
  }

  /**
   * Requests a new access token using the httpOnly refresh cookie.
   * Returns true when a new token was successfully obtained.
   */
  async refreshToken(): Promise<boolean> {
    try {
      const { accessToken } = await firstValueFrom(this.api.post<RefreshResponse>('/auth/refresh'));
      this.accessToken.set(accessToken);
      return true;
    } catch {
      // Refresh cookie is expired or absent — the session cannot be renewed.
      this.clearSession();
      return false;
    }
  }

  /**
   * Fetches the current user profile from /auth/me and updates the
   * currentUser signal and active-center state.
   *
   * Unlike loadUser(), this method does NOT call refreshToken() first —
   * it assumes a valid access token is already in memory. Used by the
   * error interceptor (B-6) when an ACTIVE_CENTER_INVALID 403 arrives
   * mid-session: the token is still valid but the user's center
   * assignments have changed, so we only need to re-sync the profile.
   *
   * Throws if the /auth/me request fails, so callers can handle the
   * error (e.g. the interceptor's catchError pipeline).
   */
  async refreshCurrentUser(): Promise<void> {
    const user = await firstValueFrom(this.api.get<User>('/auth/me'));
    this.currentUser.set(user);
    this.validateActiveCenter();
    this.validateActiveProgram();
  }

  /**
   * Attempts to restore the session on app start.
   *
   * On page refresh the in-memory access token is gone. We first call
   * /api/auth/refresh (which reads the httpOnly refresh cookie — no
   * Bearer token needed) to obtain a fresh access token, then call
   * /api/auth/me to load the user profile.
   *
   * If the refresh cookie is absent or expired both calls fail silently
   * and the user stays in the unauthenticated state.
   */
  async loadUser(): Promise<void> {
    try {
      // Step 1: get a fresh access token via the refresh cookie
      const refreshed = await this.refreshToken();
      if (!refreshed) {
        return; // no valid refresh cookie — nothing to restore
      }

      // Step 2: now we have an access token, fetch the user profile
      const user = await firstValueFrom(this.api.get<User>('/auth/me'));
      this.currentUser.set(user);
      this.validateActiveCenter();
      this.validateActiveProgram();
    } catch {
      // No valid session — stay in unauthenticated state.
      this.clearSession();
    }
  }

  // -----------------------------------------------------------------------
  // Active-center management (multi-center center_rep support)
  // -----------------------------------------------------------------------

  /**
   * Sets the active center for the current multi-center rep session.
   * Called by CenterSwitcherComponent (B-3) when the user picks a center.
   *
   * Throws if `id` is not in the user's assigned centerIds — the caller
   * must only offer valid options.
   */
  setActiveCenter(id: number): void {
    const centerIds = this.currentUser()?.centerIds ?? [];
    if (!centerIds.includes(id)) {
      throw new Error(`Center ${id} is not assigned to the current user.`);
    }
    this._activeCenterId.set(id);
    this.persistActiveCenter(id);
  }

  /**
   * Resets the active center to the user's primary (first) center.
   * Called by the error interceptor (B-6) after it detects an
   * ACTIVE_CENTER_INVALID response from the backend and reloads the
   * user profile to pick up the updated centerIds.
   */
  resetActiveCenterToFirst(): void {
    const centerIds = this.currentUser()?.centerIds ?? [];
    const primary = centerIds[0] ?? null;
    this._activeCenterId.set(primary);
    if (primary != null) {
      this.persistActiveCenter(primary);
    } else {
      this.removePersistedActiveCenter();
    }
  }

  // -----------------------------------------------------------------------
  // Active-program management (multi-program program_rep support)
  // -----------------------------------------------------------------------

  /**
   * Sets the active program for the current multi-program rep session.
   * Called by ProgramSwitcherComponent when the user picks a program.
   *
   * Throws if `id` is not in the user's assigned programIds.
   */
  setActiveProgram(id: number): void {
    const programIds = this.currentUser()?.programIds ?? [];
    if (!programIds.includes(id)) {
      throw new Error(`Program ${id} is not assigned to the current user.`);
    }
    this._activeProgramId.set(id);
    this.persistActiveProgram(id);
  }

  /**
   * Resets the active program to the user's primary (first) program.
   * Called by the error interceptor after it detects an
   * ACTIVE_PROGRAM_INVALID response from the backend and reloads the
   * user profile to pick up the updated programIds.
   */
  resetActiveProgramToFirst(): void {
    const programIds = this.currentUser()?.programIds ?? [];
    const primary = programIds[0] ?? null;
    this._activeProgramId.set(primary);
    if (primary != null) {
      this.persistActiveProgram(primary);
    } else {
      this.removePersistedActiveProgram();
    }
  }

  /**
   * Reads and parses the persisted active center ID from localStorage.
   * Called once during construction — before the user signal is populated —
   * so no centerIds validation is done here; that happens in validateActiveCenter().
   *
   * Returns null if the value is absent, unparseable, NaN, or ≤ 0.
   */
  private loadPersistedActiveCenter(): number | null {
    try {
      const raw = localStorage.getItem(ACTIVE_CENTER_STORAGE_KEY);
      if (raw == null) return null;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
    } catch {
      // localStorage unavailable (private-browsing mode, embedded iframe, etc.)
      return null;
    }
  }

  /**
   * Validates and corrects the active center after every user signal update.
   *
   * Rules:
   *  - Multi-center rep (centerIds.length > 1):
   *      Persisted ID still valid → keep it.
   *      Persisted ID null or no longer in centerIds → fall back to centerIds[0].
   *  - Single-center rep (centerIds.length === 1):
   *      Clear activeCenterId (no switcher; effectiveCenterId falls back to centerId).
   *  - Non-center-rep (centerIds empty):
   *      Clear activeCenterId and remove localStorage entry.
   */
  private validateActiveCenter(): void {
    const centerIds = this.currentUser()?.centerIds ?? [];
    const current = this._activeCenterId();

    if (centerIds.length > 1) {
      // Multi-center rep: ensure the persisted selection is still valid.
      if (current != null && centerIds.includes(current)) {
        // Still valid — nothing to do.
        return;
      }
      // First login or center was reassigned away — initialize to primary.
      const primary = centerIds[0];
      this._activeCenterId.set(primary);
      this.persistActiveCenter(primary);
    } else {
      // Single-center rep or non-center-rep: no switcher needed; clear state.
      this._activeCenterId.set(null);
      this.removePersistedActiveCenter();
    }
  }

  /** Writes the active center ID to localStorage, silently swallowing storage errors. */
  private persistActiveCenter(id: number): void {
    try {
      localStorage.setItem(ACTIVE_CENTER_STORAGE_KEY, String(id));
    } catch {
      // Ignore write failures (storage quota exceeded, private mode).
    }
  }

  /** Removes the active center entry from localStorage, ignoring errors. */
  private removePersistedActiveCenter(): void {
    try {
      localStorage.removeItem(ACTIVE_CENTER_STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }

  /**
   * Reads and parses the persisted active program ID from localStorage.
   * Called once during construction — before the user signal is populated —
   * so no programIds validation is done here; that happens in validateActiveProgram().
   *
   * Returns null if the value is absent, unparseable, NaN, or ≤ 0.
   */
  private loadPersistedActiveProgram(): number | null {
    try {
      const raw = localStorage.getItem(ACTIVE_PROGRAM_STORAGE_KEY);
      if (raw == null) return null;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
    } catch {
      return null;
    }
  }

  /**
   * Validates and corrects the active program after every user signal update.
   *
   * Rules:
   *  - Multi-program rep (programIds.length > 1):
   *      Persisted ID still valid → keep it.
   *      Persisted ID null or no longer in programIds → fall back to programIds[0].
   *  - Single-program rep (programIds.length === 1):
   *      Clear activeProgramId (no switcher; effectiveProgramId falls back to programId).
   *  - Non-program-rep (programIds empty):
   *      Clear activeProgramId and remove localStorage entry.
   */
  private validateActiveProgram(): void {
    const programIds = this.currentUser()?.programIds ?? [];
    const current = this._activeProgramId();

    if (programIds.length > 1) {
      if (current != null && programIds.includes(current)) {
        return;
      }
      const primary = programIds[0];
      this._activeProgramId.set(primary);
      this.persistActiveProgram(primary);
    } else {
      this._activeProgramId.set(null);
      this.removePersistedActiveProgram();
    }
  }

  /** Writes the active program ID to localStorage, silently swallowing storage errors. */
  private persistActiveProgram(id: number): void {
    try {
      localStorage.setItem(ACTIVE_PROGRAM_STORAGE_KEY, String(id));
    } catch {
      // Ignore write failures (storage quota exceeded, private mode).
    }
  }

  /** Removes the active program entry from localStorage, ignoring errors. */
  private removePersistedActiveProgram(): void {
    try {
      localStorage.removeItem(ACTIVE_PROGRAM_STORAGE_KEY);
    } catch {
      // Ignore.
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Wipes all in-memory auth state and active-center/program persistence. */
  private clearSession(): void {
    this.accessToken.set(null);
    this.currentUser.set(null);
    this._activeCenterId.set(null);
    this.removePersistedActiveCenter();
    this._activeProgramId.set(null);
    this.removePersistedActiveProgram();
  }
}
