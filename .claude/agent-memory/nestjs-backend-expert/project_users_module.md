---
name: Users Module and Base Entity
description: BE-1.2 completed — BaseEntity (UUID PK + timestamps), User entity with Cognito auth fields, role enum (admin/program_rep/center_rep), UsersService with upsert, migration scripts added
type: project
---

BE-1.2 Users module and base entity completed as of 2026-04-09.

**Why:** User entity is the foundation for authentication (Cognito integration) and authorization (admin-assigned roles). BaseEntity provides consistent UUID PKs and timestamp columns for all future entities.

**How to apply:**
- All new entities must extend `BaseEntity` from `src/common/entities/base.entity.ts` (provides id, createdAt, updatedAt).
- User roles are NOT from Cognito — admin assigns via the Users page. New users start with `role: null`.
- `programId` and `centerId` on User are FK placeholders — actual constraints added in Wave 2.
- Migration scripts: `npm run migration:generate`, `migration:run`, `migration:revert`.
- `@CurrentUser()` decorator available at `src/common/decorators/current-user.decorator.ts`.
- data-source.ts uses `__dirname` paths for both entities and migrations (supports both ts-node for generation and compiled JS).
