---
name: project-multicenter-centerrep
description: Locked design decisions for the multi-center center_rep feature (centerIds array, X-Active-Center header, switcher, revocation recovery)
metadata:
  type: project
---

Multi-center center_rep feature — all design questions locked as of 2026-05-17.

**Why:** Center reps need to manage projects across multiple CGIAR centers. Current schema enforces a single `centerId` FK on `users`.

**How to apply:** Use these decisions when dispatching tasks or reviewing implementation PRs for this feature.

## Schema
- New `user_centers` join table: `(id, user_id FK, center_id FK, sort_order INT NOT NULL DEFAULT 0)`, UNIQUE(user_id, center_id).
- `users.center_id` column is kept (nullable) for one release as a transition fallback; set to `centerIds[0]`.
- `users.centerIds` exposed as ordered array everywhere a user object is returned.

## Primary center
- `centerIds[0]` is always the primary. No separate "Primary" radio in the admin form.
- Admin Users form uses `p-multiselect` but maintains insertion order in its own `orderedCenterIds[]` array (push on select, splice on deselect) — does NOT rely on PrimeNG's internal value order.
- Backend receives `centerIds` in user-visible insertion order; writes sort_order = array index.

## Active center signal (frontend)
- `AuthService.activeCenterId` signal initialized to `user.centerIds[0]` on login/refresh (NOT null).
- Persisted to `localStorage.prms.activeCenterId`; restored on refresh if the stored value is still in the updated `centerIds`.
- `isMultiCenter` computed = `centerIds.length > 1`.

## X-Active-Center header
- Auth interceptor ALWAYS sends the header for multi-center reps (even when activeCenterId equals primary). No skip-when-equals-primary optimization.
- Never sent for single-center reps or non-center-rep roles.

## Backend interceptor (ActiveCenterInterceptor)
- Registered as APP_INTERCEPTOR after RolesGuard.
- Header absent → activeCenterId = centerIds[0] ?? null.
- Header present + centerIds empty → pass through silently (no 403). activeCenterId = null.
- Header present + centerIds non-empty + value in array → activeCenterId = header value.
- Header present + centerIds non-empty + value NOT in array → 403 with EXACT body: { statusCode: 403, code: 'ACTIVE_CENTER_INVALID', message: '...' }.
- The code field is the key discriminator for frontend recovery — unit tests must assert it specifically.

## Stale JWT / revocation
- Accepted staleness window: ≤15min. No forced token refresh.
- Comment documenting this must appear at token issuance site in auth.service.ts (backend).
- When stale token's X-Active-Center references a removed center → ACTIVE_CENTER_INVALID 403 → B-6 recovery.

## Frontend revocation recovery (B-6, error.interceptor.ts)
1. Detect: status 403 + error.code === 'ACTIVE_CENTER_INVALID'.
2. Call GET /auth/me (fresh centerIds from DB).
3a. If centerIds.length > 0: resetActiveCenterToFirst() + toast ("Your assigned centers changed — switched to <primary>") + retry original request once.
3b. If centerIds = []: clear signal + toast ("Your center access changed. Redirecting...") + navigate /projects. No retry.
4. If /auth/me fails: fall through to standard error handling.
- Loop guard: tag retried request clone with __activeCenterRetried flag; interceptor skips re-entry if flag set.
- Toast: PrimeNG MessageService, severity warn, life 6000ms.

## Task list (locked)
A-1 DB migration → A-2 entity/service → A-3 CRUD (parallel A-4 JWT) → A-5 interceptor + B-1 auth service + C-1 unit tests → A-6 scoping + B-2 header + B-5 users form → B-3 switcher + B-6 recovery + C-2 unit + C-3 e2e → B-4 badge → C-4 browser.
