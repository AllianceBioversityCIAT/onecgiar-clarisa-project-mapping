---
name: dev-login
description: Start the HTTP test server on port 4202 and open Playwright authenticated as a specific dev user (admin, program-rep, or center-rep). Use when testing PRMS UI changes in a browser, verifying a role-scoped flow, or reproducing a user-reported bug.
---

# PRMS dev-login

Spins up the Angular test server (HTTP, port 4202, no SSL) and opens Playwright MCP authenticated as a seeded dev user. Replaces the 7-step manual flow from CLAUDE.md.

## When to use

- The user asks to "test the UI", "check in the browser", "verify the flow", or "reproduce the bug"
- You've just made a frontend change and need to visually confirm it
- You need to run a role-specific flow (admin vs program rep vs center rep)

## Roles → emails

| Role arg | Email |
|----------|-------|
| `admin` | `admin@codeobia.com` |
| `program-rep` | `programrep@codeobia.com` |
| `center-rep` | `centerrep@codeobia.com` |

If the user doesn't specify a role, default to `admin`.

## Steps

1. **Check if test server is running** on port 4202:
   ```bash
   lsof -iTCP:4202 -sTCP:LISTEN -P -n 2>/dev/null | head -1
   ```
   If nothing is listening, start it in the background from `web/`:
   ```bash
   cd web && nohup npx ng serve --configuration test > /tmp/prms-test-server.log 2>&1 &
   ```
   Wait ~15s and poll `http://localhost:4202` until it responds with 200.

2. **Verify the API is running** on port 3000 (`curl -s http://localhost:3000/api/health` or similar). If not, tell the user — don't start the API yourself (it may conflict with their own `npm run start:dev`).

3. **Verify CORS_ORIGIN** in `api/.env` includes `http://localhost:4202`. If not, tell the user — do NOT edit `.env` (hook blocks it anyway).

4. **Navigate Playwright** to the dev-login URL:
   ```
   http://localhost:4202/auth?dev=<email>
   ```
   The backend issues a JWT + refresh cookie and Angular redirects to `/dashboard`.

5. **Wait for `/dashboard`** to load, then take a snapshot and confirm the user is authenticated (look for their name/role in the header).

6. **In-app navigation only** from here on — click links, don't `browser_navigate` to other app routes, or the in-memory access token will be lost. If you need a full-page reload, re-run the auth URL first.

## Common gotchas

- **Test server slow to start**: first boot takes 20–30s (Angular compile). Be patient.
- **Port 4202 in use from prior session**: `lsof -iTCP:4202 -sTCP:LISTEN -P -n -t | xargs kill` before re-starting.
- **CORS error in browser console**: `CORS_ORIGIN` env var is missing `http://localhost:4202` — tell the user to add it and restart the API.
- **401 on `/api/auth/dev-token`**: this endpoint only works when `NODE_ENV=development` on the API.

## Don't

- Don't `page.goto` to other app routes after auth — use click navigation
- Don't start the backend API (the user runs that themselves)
- Don't edit `.env` to fix CORS — report it to the user
