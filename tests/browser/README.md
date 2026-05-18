# PRMS Browser Tests

Ready-to-run Playwright tests covering the negotiation workflow end-to-end.

Every spec asserts against the **immutable timeline** in `mapping_negotiations` (per-mapping audit rows) and `project_negotiation_messages` (project-level chat). Each negotiation action — create, open, counter-propose, agree, allocation edit, request removal, decline removal, remove, lock, reopen — must append exactly one new row; nothing is silently updated.

## Layout

```
tests/browser/
├── playwright.config.ts          # base URL = http://localhost:4202
├── package.json                  # @playwright/test runner
├── fixtures/
│   ├── auth.ts                   # dev-login per role + timeline helpers
│   └── scenario.ts               # createTestProject / createDraftMapping / cleanup
└── negotiation/
    ├── counter-propose.spec.ts   # program-rep counter-propose → COUNTER_PROPOSED row
    ├── agree.spec.ts             # both sides agree → 2× AGREED rows + status=agreed
    ├── remove-request-flow.spec.ts # request → decline AND request → accept branches
    ├── lock-reopen.spec.ts       # lock → LOCKED, reopen → REOPENED, prior rows untouched
    └── chat.spec.ts              # 3 roles post chat; lock gate rejects with 403
```

## One-time setup

```bash
cd tests/browser
npm install
npx playwright install chromium
```

## Prerequisites for every run

1. **API + web dev server up**:
   ```bash
   # in one terminal
   cd api && npm run start:dev
   # in another
   cd web && npx ng serve --configuration test    # port 4202, HTTP, no SSL
   ```
2. **Database has the negotiation-event-type migration applied** (`1778000000000-AddLockedAndRatingUpdatedEventTypes`). Without it the `locked` and `rating_updated` enum values aren't accepted and the lock / rating-only-edit tests fail at the SQL layer.
3. **Two test users are promoted to the right roles**. Dev-login creates users with no role on first hit — promote them once via MySQL:

   ```sql
   -- center rep at center 1
   UPDATE users SET role = 'center_rep', center_id = 1
   WHERE email = 'browser-test-center@codeobia.com';

   -- program rep at program 1
   UPDATE users SET role = 'program_rep', program_id = 1
   WHERE email = 'browser-test-program@codeobia.com';
   ```

   If those emails don't exist yet, hit `GET http://localhost:4202/api/auth/dev-token?email=browser-test-center@codeobia.com` once (and again for the program user) to create them, then run the UPDATE.

## Run

```bash
cd tests/browser

# all specs, headless — point API at port 3000 so the dev-token endpoint
# isn't intercepted by the Angular dev server's catch-all proxy
PRMS_API_URL=http://localhost:3000 npx playwright test

# headed (watch the browser)
PRMS_API_URL=http://localhost:3000 npx playwright test --headed

# single suite
PRMS_API_URL=http://localhost:3000 npx playwright test negotiation/counter-propose.spec.ts

# UI mode (interactive)
PRMS_API_URL=http://localhost:3000 npx playwright test --ui

# HTML report after a run
npx playwright show-report playwright-report
```

> **Why `PRMS_API_URL=http://localhost:3000`?** The dev-token endpoint is rate-limited (10 req/60s). Hitting the web dev server (port 4202) goes through a proxy that adds latency; pointing the suite at the API directly keeps the round-trip tight and lets `global-setup.ts` cache the three role tokens before any worker spawns. When `PRMS_API_URL` includes `:3000` the fixture automatically drops the `/api` prefix (since NestJS routes are mounted at root on the API).

## Overrides

| Env var                    | Default                       | Purpose                                              |
| -------------------------- | ----------------------------- | ---------------------------------------------------- |
| `PRMS_BASE_URL`            | `http://localhost:4202`       | Frontend dev server (UI navigation)                  |
| `PRMS_API_URL`             | same as `PRMS_BASE_URL`       | API base — set to `http://localhost:3000` for speed  |
| `PRMS_API_PREFIX`          | `/api` (web) or `''` (port 3000) | API path prefix — auto-detected, override if needed |
| `PRMS_FORCE_TOKEN_REFRESH` | (unset)                       | Set to `1` to bypass the global-setup token cache    |

## How the specs cooperate with the timeline invariant

Every spec follows the same shape:

1. **Snapshot** the timeline via `GET /api/mappings/:id/negotiations`.
2. **Trigger** the action through the UI (button click) or, if the UI doesn't expose it for the test role, the API.
3. **Re-fetch** the timeline and assert:
   - `length === before.length + N` (exactly N new rows appended)
   - new rows carry the expected `eventType`, `actorRole`, `proposedAllocation`, `justification`
   - rows `[0..before.length)` are byte-identical to the snapshot (append-only invariant)

The chat spec uses the consolidated event stream (`GET /api/mappings/projects/:id/consolidated`) since chat messages live in a different table.

## Adding a new test

1. Drop a new `*.spec.ts` under `negotiation/`.
2. Bootstrap state with `createTestProject()` + `createDraftMapping()` (project codes auto-prefix with `BROWSER-NEGO-` so cleanup picks them up).
3. Use `apiAs(ROLES.CENTER_REP)` / `apiAs(ROLES.PROGRAM_REP)` / `apiAs(ROLES.ADMIN)` for setup + assertions.
4. Always end with `await cleanupByCodePrefix()` in `test.afterAll` so the shared dev DB stays tidy.

## Artifacts

Failures land in `playwright-report/` (HTML report) and `test-results/` (traces, screenshots, videos). Both are gitignored.
