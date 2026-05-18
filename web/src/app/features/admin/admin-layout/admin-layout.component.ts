import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';

/**
 * AdminLayoutComponent — secondary layout shell for the /admin route group.
 *
 * Renders a fixed-width left sidebar containing PrimeNG-styled navigation
 * links for each admin sub-section. The right content area hosts the active
 * child route via <router-outlet>.
 *
 * This component is nested inside LayoutComponent so it inherits the
 * application header automatically — it only adds the sidebar layer.
 */
@Component({
  selector: 'app-admin-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './admin-layout.component.html',
  styleUrl: './admin-layout.component.scss',
})
export class AdminLayoutComponent {
  /**
   * Sidebar navigation items for the admin section.
   * Each item maps a label and PrimeIcon to its child route path.
   */
  readonly navItems = [
    { label: 'Users', icon: 'pi pi-users', path: '/admin/users' },
    { label: 'Countries', icon: 'pi pi-globe', path: '/admin/countries' },
    { label: 'Programs', icon: 'pi pi-th-large', path: '/admin/programs' },
    { label: 'Centers', icon: 'pi pi-building', path: '/admin/centers' },
    { label: 'Snapshots', icon: 'pi pi-camera', path: '/admin/snapshots' },
    { label: 'Imports', icon: 'pi pi-file-import', path: '/admin/imports' },
    { label: 'Audit Log', icon: 'pi pi-history', path: '/admin/audit-log' },
    { label: 'Settings', icon: 'pi pi-cog', path: '/admin/settings' },
    { label: 'Email Management', icon: 'pi pi-envelope', path: '/admin/emails' },
    {
      label: 'Danger Zone',
      icon: 'pi pi-exclamation-triangle',
      path: '/admin/danger-zone',
    },
  ];
}
