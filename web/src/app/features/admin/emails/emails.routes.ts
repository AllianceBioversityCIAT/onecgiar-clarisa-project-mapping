import { Routes } from '@angular/router';

/**
 * Lazy-loaded routes for the admin email-management feature.
 *
 * Mounted as children of the admin layout route via loadChildren() in
 * app.routes.ts. The parent path segment ('emails') is declared there;
 * this file only needs the child segments.
 */
export const EMAILS_ROUTES: Routes = [
  {
    path: '',
    title: 'Email Management - PRMS',
    loadComponent: () =>
      import('./emails-list/emails-list.component').then((m) => m.EmailsListComponent),
  },
  {
    path: ':id',
    title: 'Email Detail - PRMS',
    loadComponent: () =>
      import('./emails-detail/emails-detail.component').then((m) => m.EmailsDetailComponent),
  },
];
