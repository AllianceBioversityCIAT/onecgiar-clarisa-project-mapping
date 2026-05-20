---
name: center-rep-mappings-importer
description: Finalized spec for center-rep bulk mappings importer — 6-column Excel template, 3-endpoint API, removal flow with preview warning, cap enforced. Dispatched to dev agents 2026-05-20.
metadata:
  type: project
---

## Finalized Feature Spec — Center-Rep Mappings Bulk Importer (V1)

**Status**: Dev dispatched 2026-05-20. All three design decisions locked.

**Why:** Center reps managing large portfolios need to bulk-set allocations and ratings instead of clicking through each mapping individually.

**How to apply:** Use this as the authoritative spec when reviewing tasks, QA, or follow-up scope questions.

---

### Template — 6 columns (Excel .xlsx)

| Column | Type | Rules |
|--------|------|-------|
| Project Code | string | Must exist in DB; must belong to actor's active center |
| Program Code | string | Must exist in DB (programs table) |
| Allocation % | number | 1–100; all non-removed rows per project must sum to 100 |
| Complementarity Rating | enum | `high` / `medium` / `low` (case-insensitive) |
| Efficiency Rating | enum | `high` / `medium` / `low` (case-insensitive) |
| Justification | string | Required; min 10 chars |

NO Location of Benefit column — deferred entirely. "Location" in the original request meant allocation %, not geographic LoB.

---

### Validation Rules

**Hard errors (block commit entirely):**
- Unknown project code
- Project code belongs to a different center (not actor's active center)
- Unknown program code
- Allocation % not a number or out of 1–100
- Invalid rating value
- Justification missing or < 10 chars
- Any project in the file has > 3 rows (3-mapping cap — same as real user, unlike admin importers which bypass)
- Any project's non-removed rows sum ≠ 100

**Warnings (shown in preview, user must acknowledge before commit):**
- Active mappings on a touched project that are NOT in the file — these will be removed. Shown as "Will be removed" section with project code, program code, current allocation %.

---

### API Contract — 3 Endpoints

#### 1. `GET /center-imports/mappings/template`
- Auth: center_rep, workflow_admin
- Returns: Excel .xlsx pre-filled with actor's center's current active projects + their current active mappings (one row per mapping, blanks for allocation/ratings/justification to fill in)
- No body, no DB writes

#### 2. `POST /center-imports/mappings/validate`
- Auth: center_rep, workflow_admin
- Body: multipart form with `file` (.xlsx)
- Validates the file; returns preview + `batchId` JWT (short-lived, 30min, HS256 signed, payload: `{ actorId, centerId, batchHash }` where batchHash is SHA-256 of the parsed rows)
- Response shape:
```json
{
  "batchId": "<jwt>",
  "summary": { "toCreate": 3, "toUpdate": 5, "toRemove": 2, "errors": 0 },
  "errors": [],
  "preview": {
    "toCreate": [{ "projectCode", "programCode", "allocation", "complementarityRating", "efficiencyRating" }],
    "toUpdate": [{ "projectCode", "programCode", "currentAllocation", "newAllocation", ... }],
    "toRemove": [{ "projectCode", "programCode", "currentAllocation" }]
  }
}
```
- If `errors` array is non-empty, `batchId` is omitted — commit is blocked

#### 3. `POST /center-imports/mappings/commit`
- Auth: center_rep, workflow_admin
- Body: `{ batchId: "<jwt>" }` — NO file re-upload; server re-derives rows from the session cache keyed by batchId
- Verifies JWT signature + expiry; re-runs validation (defense in depth); executes import
- Returns: `{ imported: number, removed: number, errors: [] }`

**Session cache**: In-memory Map on the NestJS process, keyed by batchId. Rows stored at validate time, evicted on commit or expiry. No new DB table needed.

---

### Commit Execution Flow (per project, in a transaction)

1. Load all current active (non-removed) mappings for the project
2. Identify rows in file for this project (the "file set") and rows in DB not in file (the "removal set")
3. If project is locked (`negotiation_locked = true`): call reopen flow — appends `reopened` event, flips all non-removed mappings to `draft`, clears agreement flags
4. For each row in file:
   - If mapping does not exist: create draft mapping (center_rep as actor), append `initiated` event
   - If mapping exists: update allocation + ratings via allocation edit path, append `counter_proposed` event (actor = uploading center rep, NOT system user)
5. For each row in removal set: append `removed` event (actor = uploading center rep), set mapping status = `removed`
6. Call startNegotiationRound: flip all `draft` mappings to `negotiating`, append `negotiation_started` event per mapping
7. All `mapping_negotiations` writes are append-only — no UPDATE on existing rows

**Attribution**: Every event row's `actor_user_id` = the uploading center rep's user ID. Never the synthetic `system@prms.cgiar.org` user.

---

### Frontend Flow — 4 screens

1. **Upload screen**: Drop zone + "Download Template" button
2. **Validation in progress**: Spinner while POST /validate runs
3. **Preview screen**: Four grouped sections:
   - "Will be created" (green) — new mappings
   - "Will be updated" (blue) — existing mappings with changed values
   - "Will be removed" (amber warning) — active mappings not in file; must be visible before Confirm
   - "Errors" (red) — if any errors, Confirm button is disabled
4. **Result screen**: Success summary or partial failure list

---

### Known Follow-ups (out of V1 scope)

- Location of Benefit column in template (deferred)
- Download result report as Excel
- Audit trail page entry for bulk imports
- Workflow_admin scoped to any center (V1 scopes to actor's active center only)
