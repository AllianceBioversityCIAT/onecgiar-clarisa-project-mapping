import { Component, signal, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { User } from '../../core/models/user.model';

interface NavItem {
  label: string;
  path: string;
  /**
   * When set, the item is only shown to users whose role is in this list.
   * When omitted the item is visible to all authenticated users.
   */
  roles?: Array<User['role']>;
  /**
   * When set, the item is hidden from users whose role is in this list.
   * Useful for items that are visible to almost everyone except a specific role.
   */
  hideForRoles?: Array<User['role']>;
}

/**
 * Shared header component used across the entire application.
 *
 * When the user is authenticated it displays the nav pills
 * (Dashboard, Projects, Mappings, Admin) and user/logout buttons.
 * When unauthenticated it shows a "Sign In" link instead.
 */
@Component({
  selector: 'app-header',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
})
export class HeaderComponent {
  readonly authService = inject(AuthService);

  readonly navItems = signal<NavItem[]>([
    { path: '/', label: 'Home' },
    // Dashboard — hidden for workflow_admin (no workflow_admin branch yet)
    { path: '/dashboard', label: 'Dashboard', hideForRoles: ['workflow_admin'] },
    { path: '/projects', label: 'Projects' },
    // Needs Assistance queue — workflow_admin only (the workflow admin's queue)
    { path: '/needs-assistance', label: 'Needs Assistance', roles: ['workflow_admin'] },
    { path: '/admin', label: 'Admin', roles: ['admin'] },
  ]);

  /**
   * Returns true when the nav item should be shown for the currently logged-in user.
   * If the item has no `roles` restriction it is always visible (to authenticated users).
   */
  isNavItemVisible(item: NavItem): boolean {
    const role = this.authService.currentUser()?.role ?? null;
    if (item.hideForRoles?.includes(role)) return false;
    if (!item.roles) return true;
    return item.roles.includes(role);
  }

  readonly userDisplayName = computed(() => {
    const user = this.authService.currentUser();
    if (!user) return '';
    const full = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    return full || user.email;
  });

  logout(): void {
    this.authService.logout();
  }
}
