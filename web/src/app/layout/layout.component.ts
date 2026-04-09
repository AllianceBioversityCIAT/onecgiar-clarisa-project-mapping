import { Component, signal, computed, HostListener, inject } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule } from '@angular/common';
import { ToolbarModule } from 'primeng/toolbar';
import { ButtonModule } from 'primeng/button';
import { AvatarModule } from 'primeng/avatar';
import { TooltipModule } from 'primeng/tooltip';
import { RippleModule } from 'primeng/ripple';
import { AuthService } from '../core/services/auth.service';

/**
 * Navigation item definition for the sidebar menu.
 */
interface NavItem {
  label: string;
  icon: string;
  route: string;
  tooltip: string;
  /** When set, the item is only visible to users with matching role. */
  adminOnly?: boolean;
}

/**
 * LayoutComponent — the application shell.
 *
 * Renders a fixed left sidebar with navigation links, a fixed top toolbar
 * with the app title and user controls, and a content area that hosts the
 * active child route via <router-outlet>.
 *
 * Sidebar behaviour:
 *  - Desktop (>=1024px): always visible, expands to 250px or collapses to
 *    60px (icon-only) when the hamburger button is clicked.
 *  - Mobile (<1024px): hidden by default, slides in as an overlay when
 *    the hamburger button is clicked; clicking the backdrop closes it.
 *
 * Auth integration:
 *  - User display name in the toolbar is derived from the currentUser signal.
 *  - The "Users" nav item is only visible to admins (isAdmin signal).
 *  - Logout is wired to AuthService.logout().
 */
@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    ToolbarModule,
    ButtonModule,
    AvatarModule,
    TooltipModule,
    RippleModule,
  ],
  templateUrl: './layout.component.html',
  styleUrl: './layout.component.scss',
})
export class LayoutComponent {
  readonly authService = inject(AuthService);

  /** Whether the sidebar is in the collapsed (icon-only) state on desktop. */
  readonly sidebarCollapsed = signal(false);

  /** Whether the mobile overlay sidebar is open. */
  readonly mobileSidebarOpen = signal(false);

  /** True when the viewport is narrower than 1024 px. */
  readonly isMobile = signal(window.innerWidth < 1024);

  /** CSS class applied to the sidebar element. */
  readonly sidebarClass = computed(() => {
    if (this.isMobile()) {
      return this.mobileSidebarOpen()
        ? 'sidebar sidebar--mobile sidebar--open'
        : 'sidebar sidebar--mobile';
    }
    return this.sidebarCollapsed() ? 'sidebar sidebar--collapsed' : 'sidebar';
  });

  /** CSS class applied to the main content wrapper. */
  readonly contentClass = computed(() => {
    if (this.isMobile()) return 'layout-content layout-content--mobile';
    return this.sidebarCollapsed()
      ? 'layout-content layout-content--collapsed'
      : 'layout-content';
  });

  /**
   * Full display name for the logged-in user, shown in the toolbar.
   * Falls back to the email address if names are not yet populated.
   */
  readonly userDisplayName = computed(() => {
    const user = this.authService.currentUser();
    if (!user) return '';
    const full = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    return full || user.email;
  });

  /**
   * Single initial used for the avatar label (first letter of first name
   * or first letter of email when the name is unavailable).
   */
  readonly userInitial = computed(() => {
    const user = this.authService.currentUser();
    if (!user) return '';
    return (user.firstName?.[0] ?? user.email?.[0] ?? '?').toUpperCase();
  });

  /**
   * Primary navigation items displayed in the sidebar.
   * The "Users" item is marked adminOnly and conditionally rendered in the template.
   */
  readonly navItems: NavItem[] = [
    { label: 'Dashboard', icon: 'pi pi-home',    route: '/dashboard', tooltip: 'Dashboard' },
    { label: 'Projects',  icon: 'pi pi-folder',  route: '/projects',  tooltip: 'Projects'  },
    { label: 'Mappings',  icon: 'pi pi-link',    route: '/mappings',  tooltip: 'Mappings'  },
    { label: 'Users',     icon: 'pi pi-users',   route: '/users',     tooltip: 'Users', adminOnly: true },
  ];

  /** Listen to window resize events to update the mobile breakpoint signal. */
  @HostListener('window:resize')
  onResize(): void {
    const mobile = window.innerWidth < 1024;
    this.isMobile.set(mobile);
    // Close mobile overlay when switching to desktop
    if (!mobile) {
      this.mobileSidebarOpen.set(false);
    }
  }

  /**
   * Toggle the sidebar.
   * On desktop: collapses/expands the sidebar.
   * On mobile: opens/closes the overlay.
   */
  toggleSidebar(): void {
    if (this.isMobile()) {
      this.mobileSidebarOpen.update(v => !v);
    } else {
      this.sidebarCollapsed.update(v => !v);
    }
  }

  /** Close the mobile overlay sidebar (called when clicking the backdrop). */
  closeMobileSidebar(): void {
    this.mobileSidebarOpen.set(false);
  }

  /** Initiates the logout flow via AuthService. */
  logout(): void {
    this.authService.logout();
  }
}
