import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastModule } from 'primeng/toast';

/**
 * App — the root application component.
 *
 * Renders the global <p-toast /> container so error messages from
 * GlobalErrorHandler and errorInterceptor are always visible regardless
 * of which route is currently active.
 *
 * The <router-outlet /> below it hosts the top-level routes:
 *  - LayoutComponent (authenticated shell with sidebar + toolbar)
 *  - AuthCallbackComponent (full-screen, no chrome)
 *  - NotFoundComponent (404 page, no chrome)
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly title = signal('PRMS Projects Registry');
}
