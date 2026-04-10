import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';

/**
 * NotFoundComponent — displayed for any route that does not match a
 * registered path (the `**` wildcard catch-all route).
 *
 * Renders a centered 404 message with a "Go to Dashboard" button so
 * users can easily return to the application.
 */
@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [RouterLink, ButtonModule],
  template: `
    <div class="not-found-container">
      <div class="not-found-content">
        <span class="not-found-code">404</span>
        <h1 class="not-found-title">Page Not Found</h1>
        <p class="not-found-message">
          The page you are looking for does not exist or has been moved.
        </p>
        <a routerLink="/dashboard">
          <p-button
            label="Go to Dashboard"
            icon="pi pi-home"
            size="large"
          />
        </a>
      </div>
    </div>
  `,
  styles: [`
    .not-found-container {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: calc(100vh - 60px);
      padding: 24px;
      background: var(--p-surface-50);
    }

    .not-found-content {
      text-align: center;
      max-width: 480px;
    }

    .not-found-code {
      display: block;
      font-size: 6rem;
      font-weight: 700;
      line-height: 1;
      color: var(--p-primary-500);
      margin-bottom: 16px;
      letter-spacing: -4px;
    }

    .not-found-title {
      font-size: 1.75rem;
      font-weight: 600;
      color: #333333;
      margin-bottom: 12px;
    }

    .not-found-message {
      font-size: 1rem;
      color: #777777;
      margin-bottom: 32px;
      line-height: 1.6;
    }
  `],
})
export class NotFoundComponent {}
