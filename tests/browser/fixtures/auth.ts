import { APIRequestContext, Page, expect, request } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Auth + API helpers for the PRMS browser test suite.
 *
 * Every test exercises the dev-login endpoint (apiPath(`/auth/dev-token`))
 * to bootstrap an authenticated session. The frontend stores the
 * access token in memory (via `?dev=<email>` on the /auth route),
 * which is how the Playwright MCP tests authenticate today.
 *
 * For API-only setup/teardown, `apiAs(email)` returns an
 * APIRequestContext pre-loaded with the Bearer token so tests can
 * drive mappings / negotiations without going through the UI.
 */

export const ROLES = {
  ADMIN: 'admin@codeobia.com',
  /* Test-scoped users — promoted on the fly to the right role via
   * the API base URL's /api/test/promote-user endpoint (if exposed)
   * or directly in MySQL. See README.md for the manual prep step. */
  CENTER_REP: 'browser-test-center@codeobia.com',
  PROGRAM_REP: 'browser-test-program@codeobia.com',
} as const;

export const API_URL =
  process.env.PRMS_API_URL ?? 'http://localhost:4202';

/**
 * Returns the API path prefix. When the suite is pointed at the API
 * directly (e.g. http://localhost:3000), the routes are mounted at
 * root (`/auth/...`). When pointed at the web dev server (the default,
 * port 4202), the nginx-style proxy strips a `/api` prefix before
 * forwarding. We detect this via PRMS_API_PREFIX, falling back to
 * `/api` for the web base and `''` for everything else.
 */
export const API_PREFIX =
  process.env.PRMS_API_PREFIX ??
  (API_URL.includes(':3000') || API_URL.includes('/api') ? '' : '/api');

/** Prepends the API prefix to a route path. */
export function apiPath(path: string): string {
  return `${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Authenticates the browser session by visiting the dev-login URL,
 * which writes the access token into the in-memory auth signal and
 * sets the refresh cookie. After this call the page lands on
 * `/dashboard` (or wherever the post-login redirect goes).
 */
export async function loginAs(page: Page, email: string): Promise<void> {
  await page.goto(`/auth?dev=${encodeURIComponent(email)}`);
  // Wait for the post-login redirect to leave the /auth route. The
  // destination depends on the user's role (dashboard / projects / etc.)
  // so we just wait until /auth is gone, then let the caller navigate.
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), {
    timeout: 15_000,
  });
}

/**
 * Per-process cache of bearer tokens keyed by email. The dev-token
 * endpoint is rate-limited; calling it once per test (let alone once
 * per fixture invocation) exhausts the limit quickly. JWTs are valid
 * for 15 minutes — plenty for a single test run.
 */
const tokenCache = new Map<string, string>();
const tokenCachePath = path.join(__dirname, '..', '.token-cache.json');

function loadFromDisk(): Record<string, { token: string; ts: number }> {
  try {
    return JSON.parse(fs.readFileSync(tokenCachePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Returns an `APIRequestContext` pre-loaded with a Bearer token for
 * the given dev user. Tokens come from the disk cache populated by
 * `global-setup.ts`; falls back to calling the dev-token endpoint
 * if the cache is empty or stale.
 */
export async function apiAs(email: string): Promise<APIRequestContext> {
  let accessToken = tokenCache.get(email);
  if (!accessToken) {
    const disk = loadFromDisk();
    if (disk[email]?.token) {
      accessToken = disk[email].token;
      tokenCache.set(email, accessToken);
    }
  }
  if (!accessToken) {
    const baseContext = await request.newContext({ baseURL: API_URL });
    const tokenRes = await baseContext.get(
      apiPath(`/auth/dev-token?email=${encodeURIComponent(email)}`),
    );
    expect(
      tokenRes.ok(),
      `dev-token request failed for ${email}: ${tokenRes.status()}`,
    ).toBeTruthy();
    accessToken = (await tokenRes.json() as { accessToken: string }).accessToken;
    tokenCache.set(email, accessToken);
    await baseContext.dispose();
  }

  return request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Convenience: fetches the negotiation thread for one mapping. The
 * timeline is the authoritative source of "what happened, in order"
 * — every browser test should assert against it after a UI action.
 */
export async function getTimeline(
  api: APIRequestContext,
  mappingId: number,
): Promise<
  Array<{
    eventType: string;
    actorRole?: string;
    proposedAllocation: number | null;
    justification: string | null;
    createdAt: string;
  }>
> {
  const res = await api.get(apiPath(`/mappings/${mappingId}/negotiations`));
  expect(res.ok(), `GET /mappings/${mappingId}/negotiations failed`).toBeTruthy();
  const body = (await res.json()) as {
    negotiations: Array<{
      eventType: string;
      actorRole?: string;
      proposedAllocation: number | null;
      justification: string | null;
      createdAt: string;
    }>;
  };
  return body.negotiations;
}

/**
 * Convenience: fetches the consolidated event stream (mapping events +
 * chat) for a project.
 */
export async function getConsolidatedEvents(
  api: APIRequestContext,
  projectId: number,
): Promise<
  Array<{
    kind: 'mapping' | 'message';
    eventType: string;
    actorRole?: string;
    proposedPercentage: number | null;
    message: string | null;
    createdAt: string;
  }>
> {
  const res = await api.get(
    apiPath(`/mappings/projects/${projectId}/consolidated`),
  );
  expect(res.ok(), `GET consolidated failed`).toBeTruthy();
  const body = (await res.json()) as {
    events: Array<{
      kind: 'mapping' | 'message';
      eventType: string;
      actorRole?: string;
      proposedPercentage: number | null;
      message: string | null;
      createdAt: string;
    }>;
  };
  return body.events;
}
