import { Routes } from '@angular/router';
import { LayoutComponent } from './layout/layout.component';
import { authGuard } from './core/guards/auth.guard';
import { roleGuard, dashboardAccessGuard } from './core/guards/role.guard';

/**
 * Root route configuration.
 *
 * All authenticated views live as children of LayoutComponent so they
 * share the sidebar + toolbar shell. The auth callback lives outside the
 * layout so it can render full-screen without chrome.
 *
 * The LayoutComponent route is protected by authGuard. Any navigation
 * to a child route when unauthenticated triggers a redirect to the
 * Cognito hosted-UI login page.
 *
 * Each route carries a `title` key used by Angular's TitleStrategy
 * (configured in app.config.ts) to update the browser tab title on
 * every navigation.
 */
export const routes: Routes = [
  /**
   * Public home page — the root URL renders the project portfolio.
   * Unauthenticated, rendered outside the authenticated shell.
   */
  {
    path: '',
    pathMatch: 'full',
    title: 'Project Portfolio - PRMS',
    loadComponent: () =>
      import('./features/public-home/public-home.component').then((m) => m.PublicHomeComponent),
  },

  /**
   * Auth callback — public route, rendered outside the shell.
   * Cognito redirects here with ?code=<authorization_code> after login.
   */
  {
    path: 'auth',
    title: 'Login - PRMS',
    loadComponent: () =>
      import('./features/auth/auth-callback/auth-callback.component').then(
        (m) => m.AuthCallbackComponent,
      ),
  },

  /**
   * Authenticated shell — guarded by authGuard.
   * All child routes inherit the protection; the sidebar/toolbar are
   * rendered by LayoutComponent which wraps every child via router-outlet.
   */
  {
    path: '',
    component: LayoutComponent,
    canActivate: [authGuard],
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },

      // Dashboard
      {
        path: 'dashboard',
        title: 'Dashboard - PRMS',
        canActivate: [dashboardAccessGuard],
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
      },

      // ----------------------------------------------------------------
      // Projects feature routes
      // ----------------------------------------------------------------

      /**
       * Project list — all authenticated users.
       * Note: /projects/new must be declared BEFORE /projects/:id so the
       * router matches the static segment first.
       */
      {
        path: 'projects',
        title: 'Projects - PRMS',
        loadComponent: () =>
          import('./features/projects/project-list/project-list.component').then(
            (m) => m.ProjectListComponent,
          ),
      },
      {
        path: 'projects/new',
        title: 'New Project - PRMS',
        loadComponent: () =>
          import('./features/projects/project-form/project-form.component').then(
            (m) => m.ProjectFormComponent,
          ),
        canActivate: [roleGuard('admin')],
      },
      {
        path: 'projects/:id',
        title: 'Project Details - PRMS',
        loadComponent: () =>
          import('./features/projects/project-detail/project-detail.component').then(
            (m) => m.ProjectDetailComponent,
          ),
      },
      {
        path: 'projects/:id/edit',
        title: 'Edit Project - PRMS',
        loadComponent: () =>
          import('./features/projects/project-form/project-form.component').then(
            (m) => m.ProjectFormComponent,
          ),
        // Widened from admin-only: unit_admin and center_rep can also reach
        // the edit form (the form itself gates which fields they can change
        // and, for center_rep, scopes editing to projects in their own center).
        canActivate: [roleGuard('admin', 'unit_admin', 'center_rep')],
      },

      // ----------------------------------------------------------------
      // Other features
      // ----------------------------------------------------------------

      // ----------------------------------------------------------------
      // Snapshots — top-level route accessible to admin AND unit_admin.
      // Admin also reaches snapshots via /admin/snapshots (the original path
      // inside the admin sidebar). This parallel route gives unit_admin a
      // direct entry point without exposing the full admin section to them.
      // ----------------------------------------------------------------
      {
        path: 'snapshots',
        title: 'Snapshots - PRMS',
        loadComponent: () =>
          import('./features/admin/snapshots-list/snapshots-list.component').then(
            (m) => m.SnapshotsListComponent,
          ),
        canActivate: [roleGuard('admin', 'unit_admin')],
      },

      // ----------------------------------------------------------------
      // Needs Assistance — workflow_admin only (the workflow admin's queue)
      // ----------------------------------------------------------------
      {
        path: 'needs-assistance',
        title: 'Needs Assistance - PRMS',
        loadComponent: () =>
          import('./features/needs-assistance/needs-assistance.component').then(
            (m) => m.NeedsAssistanceComponent,
          ),
        canActivate: [roleGuard('workflow_admin')],
      },

      {
        path: 'mappings/new',
        title: 'New Mapping - PRMS',
        loadComponent: () =>
          import('./features/mappings/mapping-form/mapping-form.component').then(
            (m) => m.MappingFormComponent,
          ),
        canActivate: [roleGuard('center_rep')],
      },
      {
        path: 'mappings/project/:projectId',
        title: 'Project Negotiation - PRMS',
        loadComponent: () =>
          import('./features/mappings/project-negotiation-consolidated/project-negotiation-consolidated.component').then(
            (m) => m.ProjectNegotiationConsolidatedComponent,
          ),
      },
      // ----------------------------------------------------------------
      // Admin section — sidebar layout with reference data + user mgmt
      // ----------------------------------------------------------------
      {
        path: 'admin',
        canActivate: [roleGuard('admin')],
        loadComponent: () =>
          import('./features/admin/admin-layout/admin-layout.component').then(
            (m) => m.AdminLayoutComponent,
          ),
        children: [
          { path: '', redirectTo: 'users', pathMatch: 'full' },
          {
            path: 'users',
            title: 'Users - PRMS',
            loadComponent: () =>
              import('./features/users/user-list/user-list.component').then(
                (m) => m.UserListComponent,
              ),
          },
          {
            path: 'countries',
            title: 'Countries - PRMS',
            loadComponent: () =>
              import('./features/admin/countries-list/countries-list.component').then(
                (m) => m.CountriesListComponent,
              ),
          },
          {
            path: 'programs',
            title: 'Programs - PRMS',
            loadComponent: () =>
              import('./features/admin/programs-list/programs-list.component').then(
                (m) => m.ProgramsListComponent,
              ),
          },
          {
            path: 'centers',
            title: 'Centers - PRMS',
            loadComponent: () =>
              import('./features/admin/centers-list/centers-list.component').then(
                (m) => m.CentersListComponent,
              ),
          },
          {
            path: 'snapshots',
            title: 'Snapshots - PRMS',
            loadComponent: () =>
              import('./features/admin/snapshots-list/snapshots-list.component').then(
                (m) => m.SnapshotsListComponent,
              ),
          },
          {
            path: 'imports',
            title: 'Imports - PRMS',
            loadComponent: () =>
              import('./features/admin/imports/admin-imports.component').then(
                (m) => m.AdminImportsComponent,
              ),
          },
          {
            path: 'audit-log',
            title: 'Audit Log - PRMS',
            loadComponent: () =>
              import('./features/admin/audit-log/audit-log.component').then(
                (m) => m.AuditLogComponent,
              ),
          },
          {
            path: 'danger-zone',
            title: 'Danger Zone - PRMS',
            loadComponent: () =>
              import('./features/admin/danger-zone/danger-zone.component').then(
                (m) => m.DangerZoneComponent,
              ),
          },
        ],
      },

      // ----------------------------------------------------------------
      // Audit log — top-level route accessible to workflow_admin and
      // unit_admin (who cannot enter the /admin sidebar group).
      // Admin also has this route via /admin/audit-log above.
      // ----------------------------------------------------------------
      {
        path: 'audit-log',
        title: 'Audit Log - PRMS',
        loadComponent: () =>
          import('./features/admin/audit-log/audit-log.component').then((m) => m.AuditLogComponent),
        canActivate: [roleGuard('admin', 'workflow_admin', 'unit_admin')],
      },
    ],
  },

  /** Backwards-compat redirect — /home now lives at / */
  { path: 'home', redirectTo: '', pathMatch: 'full' },

  {
    path: 'home/project/:id',
    title: 'Project Details - PRMS',
    loadComponent: () =>
      import('./features/public-home/public-project-detail/public-project-detail.component').then(
        (m) => m.PublicProjectDetailComponent,
      ),
  },

  /**
   * Catch-all: show the dedicated 404 Not Found page for any unrecognised path.
   * The component itself lives inside the layout-less context so the user sees
   * the plain centred error page without the sidebar shell.
   */
  {
    path: '**',
    title: '404 Not Found - PRMS',
    loadComponent: () =>
      import('./features/not-found/not-found.component').then((m) => m.NotFoundComponent),
  },
];
