import { Routes } from '@angular/router';

/**
 * Lazy-loaded routes for the admin audit-log feature.
 *
 * Mounted as children of the admin layout route, so this config only needs
 * the final path segment ('' = default index at /admin/audit-log).
 */
export const AUDIT_LOG_ROUTES: Routes = [
  {
    path: '',
    title: 'Audit Log - PRMS',
    loadComponent: () =>
      import('./audit-log.component').then((m) => m.AuditLogComponent),
  },
];
