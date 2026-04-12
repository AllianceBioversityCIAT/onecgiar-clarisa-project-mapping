import { Routes } from '@angular/router';
import { LayoutComponent } from './layout/layout.component';
import { authGuard } from './core/guards/auth.guard';
import { roleGuard } from './core/guards/role.guard';

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
   * Auth callback — public route, rendered outside the shell.
   * Cognito redirects here with ?code=<authorization_code> after login.
   */
  {
    path: 'auth',
    title: 'Login - PRMS',
    loadComponent: () =>
      import('./features/auth/auth-callback/auth-callback.component').then(
        m => m.AuthCallbackComponent,
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
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then(
            m => m.DashboardComponent,
          ),
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
            m => m.ProjectListComponent,
          ),
      },
      {
        path: 'projects/new',
        title: 'New Project - PRMS',
        loadComponent: () =>
          import('./features/projects/project-form/project-form.component').then(
            m => m.ProjectFormComponent,
          ),
        canActivate: [roleGuard('admin')],
      },
      {
        path: 'projects/:id',
        title: 'Project Details - PRMS',
        loadComponent: () =>
          import('./features/projects/project-detail/project-detail.component').then(
            m => m.ProjectDetailComponent,
          ),
      },
      {
        path: 'projects/:id/edit',
        title: 'Edit Project - PRMS',
        loadComponent: () =>
          import('./features/projects/project-form/project-form.component').then(
            m => m.ProjectFormComponent,
          ),
        canActivate: [roleGuard('admin')],
      },

      // ----------------------------------------------------------------
      // Other features
      // ----------------------------------------------------------------

      {
        path: 'mappings',
        title: 'Mappings - PRMS',
        loadComponent: () =>
          import('./features/mappings/mapping-list/mapping-list.component').then(
            m => m.MappingListComponent,
          ),
      },
      {
        path: 'mappings/new',
        title: 'New Mapping - PRMS',
        loadComponent: () =>
          import('./features/mappings/mapping-form/mapping-form.component').then(
            m => m.MappingFormComponent,
          ),
        canActivate: [roleGuard('program_rep')],
      },
      {
        path: 'mappings/:id/edit',
        title: 'Edit Mapping - PRMS',
        loadComponent: () =>
          import('./features/mappings/mapping-form/mapping-form.component').then(
            m => m.MappingFormComponent,
          ),
        canActivate: [roleGuard('program_rep')],
      },
      {
        path: 'mappings/:id/review',
        title: 'Review Mapping - PRMS',
        loadComponent: () =>
          import('./features/mappings/mapping-review/mapping-review.component').then(
            m => m.MappingReviewComponent,
          ),
        canActivate: [roleGuard('program_rep', 'center_rep', 'admin')],
      },
      // ----------------------------------------------------------------
      // Admin section — sidebar layout with reference data + user mgmt
      // ----------------------------------------------------------------
      {
        path: 'admin',
        canActivate: [roleGuard('admin')],
        loadComponent: () =>
          import('./features/admin/admin-layout/admin-layout.component').then(
            m => m.AdminLayoutComponent,
          ),
        children: [
          { path: '', redirectTo: 'users', pathMatch: 'full' },
          {
            path: 'users',
            title: 'Users - PRMS',
            loadComponent: () =>
              import('./features/users/user-list/user-list.component').then(
                m => m.UserListComponent,
              ),
          },
          {
            path: 'countries',
            title: 'Countries - PRMS',
            loadComponent: () =>
              import('./features/admin/countries-list/countries-list.component').then(
                m => m.CountriesListComponent,
              ),
          },
          {
            path: 'programs',
            title: 'Programs - PRMS',
            loadComponent: () =>
              import('./features/admin/programs-list/programs-list.component').then(
                m => m.ProgramsListComponent,
              ),
          },
          {
            path: 'centers',
            title: 'Centers - PRMS',
            loadComponent: () =>
              import('./features/admin/centers-list/centers-list.component').then(
                m => m.CentersListComponent,
              ),
          },
        ],
      },
    ],
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
      import('./features/not-found/not-found.component').then(
        m => m.NotFoundComponent,
      ),
  },
];
