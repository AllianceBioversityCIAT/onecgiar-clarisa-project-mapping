# Admin Section with Side Menu — Design

**Date:** 2026-04-12
**Scope:** Frontend-only. Admin section with sidebar layout for managing reference data and users.

## Goal

Create an `/admin` route group with a sidebar layout housing Users (existing), Countries, Programs, and Centers pages. Extensible for future admin-managed content.

## Decisions

1. **Nested layout** — `AdminLayoutComponent` nests inside `LayoutComponent`, adding a sidebar only in admin context.
2. **Users moves to `/admin/users`** — consolidates all admin pages under one route group.
3. **Reference data pages are read-only** — CLARISA is the source of truth. Just display tables with search/filter.
4. **No backend changes** — all API endpoints (`/api/users`, `/api/countries`, `/api/programs`, `/api/centers`) already exist.

## Architecture

```
LayoutComponent (existing header with nav pills)
  └─ AdminLayoutComponent (NEW — sidebar + router-outlet)
       ├─ /admin              → redirectTo /admin/users
       ├─ /admin/users        ← existing UserListComponent, re-routed
       ├─ /admin/countries    ← NEW CountriesListComponent
       ├─ /admin/programs     ← NEW ProgramsListComponent
       └─ /admin/centers      ← NEW CentersListComponent
```

All `/admin` children inherit `roleGuard('admin')` from the parent route.

## 1. AdminLayoutComponent

**Location:** `web/src/app/features/admin/admin-layout/admin-layout.component.ts`

Standalone component. Template:
- Left sidebar (~220px fixed width) with PrimeNG `p-menu` containing nav items:
  - Users (icon: `pi pi-users`, routerLink: `/admin/users`)
  - Countries (icon: `pi pi-globe`, routerLink: `/admin/countries`)
  - Programs (icon: `pi pi-th-large`, routerLink: `/admin/programs`)
  - Centers (icon: `pi pi-building`, routerLink: `/admin/centers`)
- Menu items use `routerLinkActive` for active state highlighting.
- Right content area: `<router-outlet />` fills remaining width.

Styling:
- Sidebar background: `#f8f8f8` or `surface-section` token to match PRMS theme.
- Active menu item uses primary color (`#5569dd`).
- Content area has standard page padding.
- Sidebar is not collapsible (YAGNI — can add later).

## 2. Routing changes

**`app.routes.ts`** modifications:

- Remove the standalone `/users` route (lines ~141-148).
- Add `/admin` route group:

```ts
{
  path: 'admin',
  canActivate: [roleGuard('admin')],
  component: AdminLayoutComponent,  // or lazy-load
  children: [
    { path: '', redirectTo: 'users', pathMatch: 'full' },
    {
      path: 'users',
      loadComponent: () => import('./features/users/user-list/user-list.component')
        .then(m => m.UserListComponent),
    },
    {
      path: 'countries',
      loadComponent: () => import('./features/admin/countries-list/countries-list.component')
        .then(m => m.CountriesListComponent),
    },
    {
      path: 'programs',
      loadComponent: () => import('./features/admin/programs-list/programs-list.component')
        .then(m => m.ProgramsListComponent),
    },
    {
      path: 'centers',
      loadComponent: () => import('./features/admin/centers-list/centers-list.component')
        .then(m => m.CentersListComponent),
    },
  ],
}
```

**`layout.component.ts`** — Replace `{ label: 'Users', route: '/users', adminOnly: true }` with `{ label: 'Admin', route: '/admin', adminOnly: true }`.

## 3. CountriesListComponent

**Location:** `web/src/app/features/admin/countries-list/countries-list.component.ts`

Standalone component. Uses `ReferenceDataService.getCountries()` (already exists).

PrimeNG `p-table` with:
- Columns: Name, ISO Alpha-2, ISO Alpha-3, Region
- Global search filter (client-side, same pattern as Users page)
- Sortable columns
- Paginator (rows: 20)
- Page title: "Countries"
- Subtitle or count badge: "248 countries" (from CLARISA)

No create/edit/delete — read-only.

## 4. ProgramsListComponent

**Location:** `web/src/app/features/admin/programs-list/programs-list.component.ts`

Standalone component. Uses `ReferenceDataService.getPrograms()`.

PrimeNG `p-table` with:
- Columns: Official Code, Name, CLARISA ID, Last Synced
- Global search filter
- Sortable columns
- Paginator (rows: 20)
- Page title: "Programs"

No create/edit/delete — read-only.

## 5. CentersListComponent

**Location:** `web/src/app/features/admin/centers-list/centers-list.component.ts`

Standalone component. Uses `ReferenceDataService.getCenters()`.

PrimeNG `p-table` with:
- Columns: Acronym, Name, Code, Institution ID, Last Synced
- Global search filter
- Sortable columns
- Paginator (rows: 20)
- Page title: "Centers"

No create/edit/delete — read-only.

## 6. Header nav update

In `layout.component.ts`, the `navItems` array changes:

Before: `{ label: 'Users', route: '/users', icon: 'pi-users', adminOnly: true }`
After: `{ label: 'Admin', route: '/admin', icon: 'pi-cog', adminOnly: true }`

The `routerLinkActive` on the header pill will highlight "Admin" when on any `/admin/*` route.

## 7. File structure

```
web/src/app/features/admin/
├── admin-layout/
│   ├── admin-layout.component.ts
│   ├── admin-layout.component.html
│   └── admin-layout.component.scss
├── countries-list/
│   ├── countries-list.component.ts
│   ├── countries-list.component.html
│   └── countries-list.component.scss
├── programs-list/
│   ├── programs-list.component.ts
│   ├── programs-list.component.html
│   └── programs-list.component.scss
└── centers-list/
    ├── centers-list.component.ts
    ├── centers-list.component.html
    └── centers-list.component.scss
```

Users stays at `web/src/app/features/users/` — just re-routed under `/admin/users`.

## 8. Error handling

- `ReferenceDataService` already caches for 5 minutes. If the API fails, the existing `errorInterceptor` shows a toast.
- Empty state: if no data, show PrimeNG table's built-in empty message.

## 9. Testing

- `ui-tester` via Playwright on port 4202:
  - Dev-login as admin → verify "Admin" pill in header → click → lands on `/admin/users`
  - Sidebar renders with 4 items, active item highlighted
  - Navigate to Countries → table loads 248 rows, search works
  - Navigate to Programs → table loads, search works
  - Navigate to Centers → table loads, search works
  - Non-admin user does NOT see "Admin" pill

## 10. Out of scope

- Sidebar collapse/expand
- CRUD on reference data (CLARISA is source of truth)
- Backend changes (all endpoints exist)
- "Constants management" pages (user said "later on")
