---
name: Auth Module (BE-1.3)
description: Cognito OAuth2 auth module with local JWT issuance, guards, roles, cookie-based refresh tokens
type: project
---

BE-1.3 implements Cognito authentication with local JWT issuance.

**Why:** Cognito handles authentication only; roles are managed internally by admins. The User.role column starts null and is set via admin UI.

**How to apply:**
- Auth endpoints are at /api/auth/* (login, callback, refresh, logout, me)
- JwtAuthGuard and RolesGuard are registered globally via APP_GUARD in AppModule
- Use @Public() to exempt endpoints from JWT auth
- Use @Roles(UserRole.ADMIN) to restrict by role
- Refresh tokens stored in httpOnly cookie named 'refresh_token' on path /api/auth
- Local JWTs expire in 15 minutes, contain { sub: userId, cognitoSub, role }
- cookie-parser middleware added to main.ts
