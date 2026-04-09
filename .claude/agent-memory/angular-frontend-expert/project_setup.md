---
name: PRMS Angular Project Setup
description: Angular 21 + PrimeNG 21 web app setup details, completed tasks, and file locations
type: project
---

Project: PRMS Projects Registry — Angular 21 frontend at `/Users/moayad/Documents/www/PRMS-Projects-Registry/web/`

**FE-1.1 completed (2026-04-09):** Application shell — layout, routing, theme.

Key files created:
- `src/app/layout/layout.component.ts/.html/.scss` — shell with collapsible sidebar + toolbar
- `src/app/app.routes.ts` — full route config with lazy-loaded feature components
- `src/app/features/dashboard/dashboard.component.ts`
- `src/app/features/projects/project-list/project-list.component.ts`
- `src/app/features/mappings/mapping-list/mapping-list.component.ts`
- `src/app/features/users/user-list/user-list.component.ts`
- `src/app/features/auth/auth-callback/auth-callback.component.ts`

**FE-3.1–3.4 completed (2026-04-09):** Projects feature — models, service, reference data service, list page, create/edit form, detail page.

Key files created:
- `src/app/features/projects/models/project.model.ts` — Project, ProjectListResponse, CreateProjectDto, ProjectQuery
- `src/app/features/projects/services/projects.service.ts` — CRUD + archive
- `src/app/core/models/reference-data.model.ts` — Center, Program, Country
- `src/app/core/services/reference-data.service.ts` — signal-based cache, loadAll()
- `src/app/features/projects/project-list/` — server-side paginated table with filter toolbar
- `src/app/features/projects/project-form/` — reactive form, create + edit mode
- `src/app/features/projects/project-detail/` — read-only view with mapping placeholder

**Why:** zone.js was not installed by default — had to `npm install zone.js --save` and add `"polyfills": ["zone.js"]` to angular.json build options.

**How to apply:** Always verify zone.js is in package.json when scaffolding Angular 21 projects using this repo.
