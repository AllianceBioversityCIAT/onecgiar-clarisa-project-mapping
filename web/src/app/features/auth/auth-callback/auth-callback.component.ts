import { Component, OnInit, inject } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { AuthService } from '../../../core/services/auth.service';

/**
 * AuthCallbackComponent — handles the Cognito OAuth2 redirect.
 *
 * Cognito redirects back to /auth?code=<authorization_code> after the user
 * authenticates. This component:
 *  1. Reads the `code` query parameter from the URL.
 *  2. Passes the code to AuthService.handleCallback() which exchanges it
 *     for an access token and user profile via the API.
 *  3. Navigates to the dashboard on success.
 *  4. If no code is present, redirects back to the login flow.
 *
 * A full-screen spinner is shown while the token exchange is in progress.
 */
@Component({
  selector: 'app-auth-callback',
  standalone: true,
  imports: [ProgressSpinnerModule],
  template: `
    <div class="auth-container">
      <p-progressSpinner strokeWidth="4" styleClass="auth-spinner" aria-label="Authenticating" />
      <p class="auth-message">Authenticating...</p>
    </div>
  `,
  styles: [
    `
      .auth-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        gap: 20px;
        background: #faf9f9;
      }
      .auth-message {
        font-size: 1rem;
        color: #777777;
        font-weight: 500;
      }
      ::ng-deep .auth-spinner .p-progress-spinner-circle {
        stroke: var(--p-primary-500);
      }
    `,
  ],
})
export class AuthCallbackComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  async ngOnInit(): Promise<void> {
    const code = this.route.snapshot.queryParamMap.get('code');
    const devEmail = this.route.snapshot.queryParamMap.get('dev');

    // Dev-login shortcut: /auth?dev=admin@codeobia.com
    if (devEmail) {
      try {
        await this.authService.devLogin(devEmail);
        await this.navigatePostLogin();
      } catch {
        await this.authService.login();
      }
      return;
    }

    if (!code) {
      await this.authService.login();
      return;
    }

    try {
      await this.authService.handleCallback(code);
      await this.navigatePostLogin();
    } catch {
      await this.authService.login();
    }
  }

  /**
   * Resume the URL the user was trying to reach before being bounced to
   * the auth flow. Falls back to the dashboard when nothing was stashed
   * (e.g. user clicked Login from the home page).
   */
  private async navigatePostLogin(): Promise<void> {
    const returnUrl = this.authService.consumeReturnUrl();
    if (returnUrl) {
      await this.router.navigateByUrl(returnUrl);
      return;
    }
    await this.router.navigate(['/dashboard']);
  }
}
