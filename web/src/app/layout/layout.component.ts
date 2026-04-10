import { Component, signal, computed, inject } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../core/services/auth.service';

/**
 * Navigation item definition for the top navigation bar.
 */
interface NavItem {
  label: string;
  path: string;
  /** When set, the item is only visible to admin users. */
  adminOnly?: boolean;
}

/**
 * LayoutComponent — the application shell.
 *
 * Renders a sticky two-row dark header (branding + user row, nav row) that
 * spans the full viewport width, and a full-width content area below it that
 * hosts the active child route via <router-outlet>.
 *
 * Header design follows the risk.cgiar.org dark navy aesthetic:
 *  - Top row (~44px): dark gradient, logo, app title, user name + logout.
 *  - Nav row (~30px): slightly lighter gradient, horizontal nav links with
 *    an #eb2f64 underline on the active link.
 *
 * Auth integration:
 *  - User display name is derived from the currentUser signal.
 *  - The "Users" nav item is only visible to admins (isAdmin computed signal).
 *  - Logout is wired to AuthService.logout().
 */
@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
  ],
  templateUrl: './layout.component.html',
  styleUrl: './layout.component.scss',
})
export class LayoutComponent {
  readonly authService = inject(AuthService);

  /**
   * Primary navigation items displayed in the top nav bar.
   * The "Users" item is marked adminOnly and is conditionally rendered
   * in the template so the route is never hinted at to non-admin users.
   */
  readonly navItems = signal<NavItem[]>([
    { path: '/dashboard', label: 'Dashboard' },
    { path: '/projects',  label: 'Projects'  },
    { path: '/mappings',  label: 'Mappings'  },
    { path: '/users',     label: 'Users', adminOnly: true },
  ]);

  /**
   * Full display name for the logged-in user, shown in the header.
   * Falls back to the email address when first/last names are not populated.
   */
  readonly userDisplayName = computed(() => {
    const user = this.authService.currentUser();
    if (!user) return '';
    const full = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    return full || user.email;
  });

  /** Initiates the logout flow via AuthService. */
  logout(): void {
    this.authService.logout();
  }
}
