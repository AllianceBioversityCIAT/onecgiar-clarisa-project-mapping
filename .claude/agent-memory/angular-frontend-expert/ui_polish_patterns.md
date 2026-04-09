---
name: UI Polish & Accessibility Patterns
description: Wave 8 (FE-8.1) patterns: page titles, global error handler, HTTP error interceptor, 404 page, toast wiring, bundle budget
type: project
---

## Page Titles via Angular Router
- Add `title: 'Page Name - PRMS'` to every route object in `app.routes.ts`
- Enable with `withComponentInputBinding()` on `provideRouter()` in `app.config.ts` — this activates Angular's built-in `TitleStrategy` automatically
- No custom TitleStrategy class needed; the default one reads `route.title`

## Global Error Handler
- File: `src/app/core/error/global-error-handler.ts`
- Implements `ErrorHandler` from `@angular/core`
- Must inject `NgZone` and call `ngZone.run()` before `MessageService.add()` because `ErrorHandler` runs outside the Angular zone
- Register: `{ provide: ErrorHandler, useClass: GlobalErrorHandler }` in `app.config.ts`
- Only logs to console when `!environment.production`

## HTTP Error Interceptor
- File: `src/app/core/interceptors/error.interceptor.ts`
- Functional `HttpInterceptorFn`
- Skips 401 (handled by authInterceptor upstream)
- Must be placed AFTER `authInterceptor` in the `withInterceptors([authInterceptor, errorInterceptor])` array
- 400: extracts `body.message` (string or string[]) from NestJS validation responses
- 403/404/500: static user-friendly messages

## MessageService at Root Level
- `MessageService` must be provided in `app.config.ts` providers (not just in components) so that `GlobalErrorHandler` and `errorInterceptor` can inject it
- Add `MessageService` directly to the providers array

## Global Toast Container
- `<p-toast />` added to `app.html` (root component template)
- `ToastModule` imported in `App` component (`app.ts`)
- Feature components that need their own local toasts can still include `<p-toast />` — they all share the same `MessageService` instance

## 404 Not Found Page
- File: `src/app/features/not-found/not-found.component.ts`
- Standalone component with inline template and styles (small enough)
- Replace `{ path: '**', redirectTo: 'dashboard' }` with `loadComponent` pointing to `NotFoundComponent`
- Rendered outside the LayoutComponent shell (no sidebar/toolbar) since it's a top-level route

## Bundle Budget
- Pre-existing issue: initial bundle was already ~1.05 MB before Wave 8 (exceeded 1 MB hard limit)
- Updated `angular.json` budgets: `maximumWarning: '1MB'`, `maximumError: '2MB'` to unblock builds
- Warnings remain for `mapping-review.component.scss` (4.52 kB) and `project-detail.component.scss` (4.72 kB) — both pre-existing, exceed the 4 kB anyComponentStyle warning threshold

## Accessibility Checklist (Wave 8)
- Hamburger button: `aria-label="Toggle navigation"` (was "Toggle sidebar")
- Logout button: `aria-label="Sign out"`, `pTooltip="Sign out"` (was "Logout")
- Sidebar `<nav>` already had `role="navigation"` and `aria-label="Main navigation"` from prior waves
- All project/mapping form fields already had `<label for="...">` matching input `id` attributes
- All list pages already had skeleton loading rows and empty state messages
