import { request } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Playwright global setup — runs ONCE before any spec.
 *
 * The dev-token endpoint is rate-limited (10 req/60s on the auth
 * controller). Letting each spec/worker call it individually blows
 * the limit fast. We hit it exactly three times here (one per role),
 * cache the tokens to disk, and the per-test fixture reads them back.
 *
 * Set `PRMS_FORCE_TOKEN_REFRESH=1` to force a re-fetch when tokens
 * have expired (15-minute TTL).
 */
async function globalSetup() {
  const apiUrl = process.env.PRMS_API_URL ?? 'http://localhost:4202';
  const apiPrefix =
    process.env.PRMS_API_PREFIX ??
    (apiUrl.includes(':3000') || apiUrl.includes('/api') ? '' : '/api');

  const roles = [
    'admin@codeobia.com',
    'browser-test-center@codeobia.com',
    'browser-test-program@codeobia.com',
  ];

  const cachePath = path.join(__dirname, '.token-cache.json');
  const existing: Record<string, { token: string; ts: number }> = fs.existsSync(
    cachePath,
  )
    ? JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    : {};

  const ctx = await request.newContext({ baseURL: apiUrl });
  const cache: Record<string, { token: string; ts: number }> = {};
  for (const email of roles) {
    // Reuse cached token when it's <10 minutes old (well below the 15-min JWT TTL).
    const cached = existing[email];
    const fresh =
      cached && Date.now() - cached.ts < 10 * 60_000 &&
      !process.env.PRMS_FORCE_TOKEN_REFRESH;
    if (fresh) {
      cache[email] = cached;
      continue;
    }
    const res = await ctx.get(
      `${apiPrefix}/auth/dev-token?email=${encodeURIComponent(email)}`,
    );
    if (!res.ok()) {
      throw new Error(
        `globalSetup: dev-token for ${email} returned ${res.status()}. ` +
          `If this is 429, wait 60s or set PRMS_FORCE_TOKEN_REFRESH=0 to reuse cache.`,
      );
    }
    const body = (await res.json()) as { accessToken: string };
    cache[email] = { token: body.accessToken, ts: Date.now() };
  }
  await ctx.dispose();
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

export default globalSetup;
