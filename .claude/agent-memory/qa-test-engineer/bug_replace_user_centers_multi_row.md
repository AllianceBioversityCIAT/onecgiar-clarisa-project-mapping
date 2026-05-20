---
name: bug-replace-user-centers-multi-row
description: replaceUserCenters() bug — TypeORM multi-row insert into non-entity string table loses sort_order for secondary rows; all rows get sort_order=0
metadata:
  type: project
---

Bug found during Wave C QA (2026-05-17). Tracked in C3-9 as `it.failing`.

**Symptom:** `POST /users` or `PATCH /users/:id` with `centerIds:[1,2]` returns 201 and the response carries correct `centerIds:[1,2]` (sourced from the M2M `centers` relation), BUT the raw `user_centers` junction table rows both have `sort_order=0` instead of `sort_order=0` for C1 and `sort_order=1` for C2.

**Root cause:** `UsersService.replaceUserCenters()` uses:
```ts
manager.createQueryBuilder()
  .insert()
  .into('user_centers')   // string, NOT entity class
  .values([{user_id, center_id:1, sort_order:0}, {user_id, center_id:2, sort_order:1}])
  .execute()
```
TypeORM uses row[0] as the column-set template for all rows when the target is a plain string table name (no entity metadata). In the ts-jest runtime this silently clones row[0]'s `sort_order:0` value into row[1], losing `sort_order:1`. In the node binary runtime it generates a column-less VALUES clause that MySQL rejects entirely ("Column count doesn't match").

**Fix (for nestjs-backend-expert):** Replace the QueryBuilder chain with a raw parameterised INSERT:
```ts
const placeholders = orderedCenterIds.map(() => '(?,?,?)').join(',');
const flatParams = orderedCenterIds.flatMap((cid, i) => [userId, cid, i]);
await manager.query(
  `INSERT INTO user_centers (user_id, center_id, sort_order) VALUES ${placeholders}`,
  flatParams,
);
```
Same fix applies to the `updateUser` path (which calls the same `replaceUserCenters()` private method).

**Effect:** Primary center display is correct (centerIds[0] mirrors users.center_id), but the sort_order-based ordering is broken for all secondary centers. The `X-Active-Center` interceptor validation still works because it checks array membership (not sort_order). The broken sort_order means the center switcher dropdown order is non-deterministic for multi-center reps.

**Why:** Discovered by the C3-9 e2e assertion that checks DB row sort_order values immediately after user creation.

**How to apply:** When the fix lands, remove `it.failing` from C3-9 in `api/test/multi-center.e2e-spec.ts` and verify the test goes green.
