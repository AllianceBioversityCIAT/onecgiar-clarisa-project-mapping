---
name: Auth Patterns — FE-1.2
description: Cognito OAuth2 flow implementation patterns established in FE-1.2
type: project
---

## Auth architecture (FE-1.2, completed 2026-04-09)

**Token storage rule**: Access token is held only in an Angular signal (in-memory). Never written to localStorage or sessionStorage. httpOnly refresh cookie is managed entirely by the API.

**Session recovery**: AuthService constructor calls `loadUser()` which hits `GET /api/auth/me`. The API returns `{ user, accessToken }` if a valid refresh cookie exists — no user action needed.

**Interceptor pattern**: Functional `HttpInterceptorFn` (`authInterceptor`). Registered via `withInterceptors([authInterceptor])` in `appConfig`. Do NOT mix with `withInterceptorsFromDi()` — they are mutually exclusive in Angular 21.

**Guard pattern**: Functional `CanActivateFn`. `authGuard` calls `authService.login()` (full-page redirect to Cognito) when unauthenticated. `roleGuard` is a factory: `roleGuard('admin')` returns a `CanActivateFn`.

**401 refresh loop prevention**: The interceptor checks if the failing request URL contains `/auth/refresh`, `/auth/logout`, or `/auth/me` before attempting a refresh — prevents infinite loops.

**Admin-only nav**: LayoutComponent reads `authService.isAdmin()` signal in the template with `@if (!item.adminOnly || authService.isAdmin())`. The "Users" nav item has `adminOnly: true` in the `NavItem` array.

**Key file locations**:
- `web/src/app/core/models/user.model.ts` — User, AuthCallbackResponse, LoginUrlResponse, RefreshResponse interfaces
- `web/src/app/core/services/api.service.ts` — ApiService (HttpClient wrapper, withCredentials always)
- `web/src/app/core/services/auth.service.ts` — AuthService (signals, Cognito flow)
- `web/src/app/core/interceptors/auth.interceptor.ts` — authInterceptor (functional)
- `web/src/app/core/guards/auth.guard.ts` — authGuard (functional)
- `web/src/app/core/guards/role.guard.ts` — roleGuard factory (functional)
- `web/src/app/features/auth/auth-callback/auth-callback.component.ts` — handles ?code= redirect

**Why**: Access token in memory only prevents XSS token theft. httpOnly cookie for refresh means Angular never touches the long-lived credential.

**How to apply**: Follow the same pattern for any future auth-sensitive feature. Use `authService.currentUser()` signal for reactive user data in templates. Use `roleGuard('admin')` for admin-only routes.
