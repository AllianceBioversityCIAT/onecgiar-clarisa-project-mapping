---
name: Dashboard & Users Patterns (Wave 7)
description: Patterns established in FE-7.1 and FE-7.2 — role-aware dashboard, chart integration, user management dialog
type: project
---

## chart.js must be installed separately

PrimeNG's ChartModule wraps chart.js but does NOT bundle it. Run:
  npm install chart.js
Import ChartModule from 'primeng/chart' in the component.

## ToggleSwitch import path

Use `ToggleSwitchModule` from `'primeng/toggleswitch'` (not toggleswitch or toggle-switch).

## Role-aware dashboard pattern

Use `computed(() => authService.currentUser()?.role)` for role signal, then `@if (userRole() === 'admin')` blocks in the template. Type-guard functions (isAdminSummary, etc.) narrow the union response type returned by the API.

## Signal-based client-side filtering

Pattern used in UserListComponent:
```ts
readonly filteredUsers = computed(() => {
  const q = searchText().toLowerCase();
  return !q ? users() : users().filter(u => ...);
});
```
Bind search input with `(input)="searchText.set($any($event.target).value)"`.

## Promise-based observable fetching in ngOnInit

When fetching multiple observables in parallel inside ngOnInit, wrap each in a Promise and use Promise.all — avoids nested subscriptions and cleanly tracks loading state:
```ts
await Promise.all([fetchSummary(), fetchActivity()]).finally(() => loading.set(false));
```

## users feature structure (FE-7.2)

- `features/users/models/user-management.model.ts` — UserWithRelations, UpdateUserDto
- `features/users/services/users.service.ts` — getUsers(), updateUser()
- `features/users/user-list/` — component, template, scss

## /users route is admin-only

roleGuard('admin') added in app.routes.ts Wave 7. Was missing before.
