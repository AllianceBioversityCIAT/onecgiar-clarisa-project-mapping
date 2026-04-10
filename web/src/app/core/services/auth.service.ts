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

  // -----------------------------------------------------------------------
  // Derived computed signals
  // -----------------------------------------------------------------------

  /** True when a user is actively logged in. */
  readonly isAuthenticated = computed(() => !!this.currentUser());

  /** True when the logged-in user has the 'admin' role. */
  readonly isAdmin = computed(() => this.currentUser()?.role === 'admin');

  /** True when the logged-in user has the 'program_rep' role. */
  readonly isProgramRep = computed(() => this.currentUser()?.role === 'program_rep');

  /** True when the logged-in user has the 'center_rep' role. */
  readonly isCenterRep = computed(() => this.currentUser()?.role === 'center_rep');

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
      const { url } = await firstValueFrom(
        this.api.get<LoginUrlResponse>('/api/auth/login'),
      );
      window.location.href = url;
    } catch {
      // If the API is unreachable the user stays on the current page.
      // A toast or global error handler will surface the problem.
    }
  }

  /**
   * Dev-only login bypassing Cognito. Calls the dev-token endpoint
   * which returns a JWT + sets a refresh cookie directly.
   */
  async devLogin(email: string): Promise<void> {
    const { accessToken, user } = await firstValueFrom(
      this.api.get<AuthCallbackResponse>(`/api/auth/dev-token?email=${encodeURIComponent(email)}`),
    );
    this.accessToken.set(accessToken);
    this.currentUser.set(user);
  }

  /**
   * Exchanges the OAuth2 authorization code (from the Cognito redirect)
   * for an access token and user profile. Stores both in memory signals.
   *
   * Called by AuthCallbackComponent after Cognito redirects back with ?code=…
   */
  async handleCallback(code: string): Promise<void> {
    const { accessToken, user } = await firstValueFrom(
      this.api.post<AuthCallbackResponse>('/api/auth/callback', { code }),
    );

    this.accessToken.set(accessToken);
    this.currentUser.set(user);
  }

  /**
   * Logs the user out.
   * Calls the API to invalidate the refresh cookie server-side, clears
   * all in-memory state, then redirects to the auth page.
   */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.api.post<void>('/api/auth/logout'));
    } catch {
      // Even if the API call fails, clear client state and redirect.
    } finally {
      this.clearSession();
      await this.router.navigate(['/auth']);
    }
  }

  /**
   * Requests a new access token using the httpOnly refresh cookie.
   * Returns true when a new token was successfully obtained.
   */
  async refreshToken(): Promise<boolean> {
    try {
      const { accessToken } = await firstValueFrom(
        this.api.post<RefreshResponse>('/api/auth/refresh'),
      );
      this.accessToken.set(accessToken);
      return true;
    } catch {
      // Refresh cookie is expired or absent — the session cannot be renewed.
      this.clearSession();
      return false;
    }
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
      const user = await firstValueFrom(
        this.api.get<User>('/api/auth/me'),
      );
      this.currentUser.set(user);
    } catch {
      // No valid session — stay in unauthenticated state.
      this.clearSession();
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Wipes all in-memory auth state. */
  private clearSession(): void {
    this.accessToken.set(null);
    this.currentUser.set(null);
  }
}
