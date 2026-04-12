import { Component, signal, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

interface NavItem {
  label: string;
  path: string;
  adminOnly?: boolean;
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
    { path: '/dashboard', label: 'Dashboard' },
    { path: '/projects', label: 'Projects' },
    { path: '/mappings', label: 'Mappings' },
    { path: '/admin', label: 'Admin', adminOnly: true },
  ]);

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
