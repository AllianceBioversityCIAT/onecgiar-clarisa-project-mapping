# User Add / Edit / Delete — Design

**Date:** 2026-04-11
**Author:** Claude (brainstormed with Moayad)
**Scope:** Admin-facing user management in PRMS Projects Registry

## Goal

Let admins add new users (before they log in via Cognito), edit existing users, and soft-delete (deactivate) them. Edit already exists; Add and Delete are new.

## Decisions

1. **Add user = pre-provision by email.** Admin creates a user record with `cognito_sub = NULL`. On first Cognito login, the existing user is matched by email and `cognito_sub` is backfilled.
2. **Delete = soft delete** (`isActive = false`). Preserves audit trail on `projects.created_by`, `project_mappings.submitted_by`, `project_mappings.reviewed_by`.
3. **Edit = unchanged.** Still only edits `role`, `programId`, `centerId`, `isActive`. No name or email editing.

## Architecture

Three coordinated changes:

- **Migration**: `users.cognito_sub` becomes nullable.
- **Backend**: new `POST /api/users` and `DELETE /api/users/:id` endpoints; `upsertFromCognito` gains email-match backfill.
- **Frontend**: new "Add User" dialog, per-row "Deactivate" action, "Show inactive" toggle.

## 1. Database migration

Generate via `new-migration` skill, review via `typeorm-migration-reviewer`.

```sql
-- up
ALTER TABLE users MODIFY cognito_sub VARCHAR(255) NULL;

-- down
-- Backfill any NULL cognito_sub values with a sentinel so NOT NULL can be re-applied.
UPDATE users SET cognito_sub = CONCAT('pending-', id) WHERE cognito_sub IS NULL;
ALTER TABLE users MODIFY cognito_sub VARCHAR(255) NOT NULL;
```

UNIQUE constraint on `cognito_sub` is preserved — MySQL permits multiple `NULL` values under a UNIQUE index, so pre-provisioned users coexist safely.

## 2. Backend — `api/src/modules/users/`

### `dto/create-user.dto.ts` (new)

```
email        string, @IsEmail, required
firstName    string, @IsString @MaxLength(100), required
lastName     string, @IsString @MaxLength(100), required
role         UserRole enum, @IsOptional @IsEnum(UserRole)
programId    number, @IsOptional @IsInt — @ValidateIf(role === PROGRAM_REP) required
centerId     number, @IsOptional @IsInt — @ValidateIf(role === CENTER_REP) required
isActive     boolean, @IsOptional, defaults to true
```

Cross-field validation mirrors the existing `update-user.dto.ts` pattern.

### `users.service.ts`

**New method `createUser(dto: CreateUserDto): Promise<UserWithRelations>`**

1. `repo.findOne({ where: { email: dto.email } })` — if any user exists, throw `ConflictException('User with this email already exists')`.
2. If `dto.programId` is set, verify program exists (throw `NotFoundException` otherwise). Same for `centerId`.
3. `const user = repo.create({ ...dto, cognitoSub: null, isActive: dto.isActive ?? true })`.
4. `await repo.save(user)`.
5. Return `findAllWithRelations`-equivalent single-user fetch so the frontend gets hydrated `program` / `center` objects.

**New method `softDelete(id: number, actingUserId: number): Promise<{ id: number; isActive: false }>`**

1. `findById(id)` — throw `NotFoundException` if missing.
2. If `id === actingUserId`, throw `ForbiddenException('You cannot deactivate your own account')`.
3. `repo.update(id, { isActive: false })`.
4. Return `{ id, isActive: false }`.

**Extend existing `upsertFromCognito(payload)`** — the email-fallback branch already added in commit `65e2707` (observation 196) is the hook. Extend it so that when an email match returns a user with `cognito_sub IS NULL`, the Cognito `sub` is written onto that row:

```ts
if (!userBySub) {
  const userByEmail = await this.repo.findOne({ where: { email: payload.email } });
  if (userByEmail && userByEmail.cognitoSub == null) {
    userByEmail.cognitoSub = payload.sub;
    // optionally: only overwrite firstName/lastName if admin left them empty
    return this.repo.save(userByEmail);
  }
  if (userByEmail && userByEmail.cognitoSub !== payload.sub) {
    // Existing behavior: return the existing record; do not hijack.
    return userByEmail;
  }
  // ... existing create path
}
```

### `users.controller.ts`

```ts
@Post()
@Roles(UserRole.ADMIN)
async create(@Body() dto: CreateUserDto) {
  return this.usersService.createUser(dto);
}

@Delete(':id')
@Roles(UserRole.ADMIN)
async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: User) {
  return this.usersService.softDelete(id, actor.id);
}
```

`@CurrentUser()` decorator is already in use elsewhere in the codebase; reuse it.

## 3. Frontend — `web/src/app/features/users/`

### `models/user-management.model.ts`

Add:

```ts
export interface CreateUserDto {
  email: string;
  firstName: string;
  lastName: string;
  role?: UserRole;
  programId?: number;
  centerId?: number;
  isActive?: boolean;
}
```

### `services/users.service.ts`

Add two methods:

```ts
createUser(dto: CreateUserDto): Observable<UserWithRelations> {
  return this.http.post<UserWithRelations>(`${this.base}/users`, dto);
}

deleteUser(id: number): Observable<void> {
  return this.http.delete<void>(`${this.base}/users/${id}`);
}
```

### `user-list/user-list.component.ts` + `.html`

Three additions:

**(a) "Add User" button + create dialog**
- Button next to the existing search input in the page header.
- New signal `showCreateDialog = signal(false)` and a reactive `createForm: FormGroup` with fields matching `CreateUserDto`.
- Dialog mirrors the existing edit dialog layout; role conditionally shows `programId` or `centerId` select.
- Submit → `usersService.createUser(dto)` → on success, push the new user into `users()`, close dialog, toast `"User created"`.
- On 409 (duplicate email), set a form-level error on the email control so the admin sees inline feedback.

**(b) Per-row "Deactivate" action**
- Column in the PrimeNG table with a `p-button` using `severity="danger"` and icon `pi pi-ban` (semantically correct — this is deactivation, not deletion).
- Click opens PrimeNG `ConfirmDialog` with text: *"Deactivate {{ user.fullName }}? They will be hidden from the list and unable to log in, but their history will be preserved."*
- Confirm → `usersService.deleteUser(id)` → update the local row's `isActive = false` in the signal → toast `"User deactivated"`.
- Button is hidden when `user.id === currentUser.id` (mirrors backend self-deactivation guard).

**(c) "Show inactive" toggle**
- `p-toggleswitch` above the table labelled "Show inactive users".
- Backed by a `showInactive = signal(false)` and a `filteredUsers = computed(...)` that applies both the existing text search and the active-filter.
- When enabled, inactive rows render with `opacity: 0.55` and an "Inactive" `p-tag severity="secondary"` in the name cell.
- The existing edit dialog already supports flipping `isActive` back on → no extra work needed for reactivation.

## 4. Error handling

| Scenario | Backend response | Frontend handling |
|---|---|---|
| Add user with duplicate email | `409 ConflictException` | Form-level error on email field |
| Add user with invalid `programId` / `centerId` | `404 NotFoundException` | Generic error toast |
| Add user with role=PROGRAM_REP but no programId | `400 BadRequestException` (class-validator) | Field-level form error |
| Delete self | `403 ForbiddenException` | Button hidden preemptively; toast if reached |
| Delete nonexistent user | `404 NotFoundException` | Toast + refresh list |
| Pre-provisioned user logs in via Cognito | `upsertFromCognito` backfills `cognito_sub` | Transparent to user |
| Pre-provisioned user logs in with different name than admin typed | Existing record's `firstName`/`lastName` are preserved (admin's version wins) | N/A |

## 5. Testing

### Backend unit tests (`api/src/modules/users/users.service.spec.ts`)
- `createUser` with fresh email → creates user with `cognitoSub: null`.
- `createUser` with duplicate email → throws `ConflictException`.
- `createUser` with `role=PROGRAM_REP, programId=999` (nonexistent) → throws `NotFoundException`.
- `softDelete` happy path → sets `isActive = false`.
- `softDelete` of self → throws `ForbiddenException`.
- `upsertFromCognito` with pre-provisioned user (email match, `cognito_sub = null`) → backfills `cognitoSub`.
- `upsertFromCognito` with email-match-but-different-sub → returns existing record unchanged (no takeover).

### Backend e2e (`api/test/users.e2e-spec.ts`)
- `POST /users` as admin → 201, user in DB.
- `POST /users` as non-admin → 403.
- `POST /users` with duplicate email → 409.
- `DELETE /users/:id` as admin on other user → 200, row `is_active = 0` in DB.
- `DELETE /users/:id` as admin on self → 403.
- `DELETE /users/:id` as non-admin → 403.

### Frontend
- `ui-tester` agent validates via Playwright on port 4202:
  - Dev-login as admin → navigate to `/users` → add user flow completes and row appears.
  - Deactivate flow: confirm dialog → row disappears (with toggle off) → reappears (with toggle on) → re-activate via edit dialog.
  - Self-deactivate button is not rendered for the current admin's own row.

## 6. Out of scope

- Editing `firstName` / `lastName` / `email` — explicitly deferred (decision 3).
- Hard delete — explicitly deferred (decision 2).
- Password-based accounts — the project is Cognito-only.
- Bulk operations (bulk deactivate, bulk role-assign).
- Audit log of user admin actions.

## 7. Agent routing (per CLAUDE.md)

Per CLAUDE.md's agent workflow rules, implementation dispatches through `tech-project-manager`, which fans out to:

- `nestjs-backend-expert` — migration, DTO, service methods, controller endpoints, unit + e2e tests.
- `typeorm-migration-reviewer` — mandatory review of the `cognito_sub` nullable migration before merge.
- `angular-frontend-expert` — create dialog, delete action, show-inactive toggle, service methods.
- `ui-tester` — Playwright validation of the full flow.
- `qa-test-engineer` — API + DB validation (conflict, forbidden self-delete, backfill-on-login).
