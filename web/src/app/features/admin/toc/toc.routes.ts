import { Routes } from '@angular/router';

/**
 * Lazy-loaded routes for the TOC admin viewer.
 *
 * Mounted as a child of the admin layout route via loadComponent() in
 * app.routes.ts. The parent path segment ('toc') is declared there;
 * this file only needs the single index route.
 */
export const TOC_ROUTES: Routes = [
  {
    path: '',
    title: 'TOC Data - PRMS',
    loadComponent: () => import('./toc.component').then((m) => m.TocComponent),
  },
];
