import { APIRequestContext, expect } from '@playwright/test';
import { apiAs, apiPath, ROLES } from './auth';

/**
 * Scenario builder for negotiation tests.
 *
 * Each test starts with a clean slate: a fresh test project, a draft
 * mapping (or a negotiating mapping, depending on the helper), and
 * actors with the right roles. Cleanup is left to the calling spec's
 * `test.afterAll` (use `cleanupByCodePrefix`).
 */

export const TEST_CODE_PREFIX = 'BROWSER-NEGO-';
export const CENTER_ID = 1;
export const PROGRAM_ID = 1;

/**
 * Creates a project via the admin API and returns its id. The code is
 * prefixed so the suite's `cleanupByCodePrefix` can find and delete it.
 */
export async function createTestProject(opts?: {
  name?: string;
  totalBudget?: number;
  centerId?: number;
}): Promise<{ id: number; code: string }> {
  const admin = await apiAs(ROLES.ADMIN);
  const code = `${TEST_CODE_PREFIX}${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const res = await admin.post(apiPath('/projects'), {
    data: {
      code,
      name: opts?.name ?? `Browser Test Project ${code}`,
      totalBudget: opts?.totalBudget ?? 100_000,
      centerId: opts?.centerId ?? CENTER_ID,
    },
  });
  expect(res.ok(), `create project failed: ${res.status()}`).toBeTruthy();
  const project = (await res.json()) as { id: number };
  await admin.dispose();
  return { id: project.id, code };
}

/**
 * Creates a draft mapping for the given project. Center rep token is
 * used so the actor role on the INITIATED event is `center_rep`.
 */
export async function createDraftMapping(
  projectId: number,
  opts?: {
    programId?: number;
    allocationPercentage?: number;
  },
): Promise<{ id: number }> {
  const center = await apiAs(ROLES.CENTER_REP);
  const res = await center.post(apiPath('/mappings'), {
    data: {
      projectId,
      programId: opts?.programId ?? PROGRAM_ID,
      allocationPercentage: opts?.allocationPercentage ?? 50,
      complementarityRating: 'high',
      efficiencyRating: 'high',
    },
  });
  expect(res.ok(), `create mapping failed: ${res.status()}`).toBeTruthy();
  const mapping = (await res.json()) as { id: number };
  await center.dispose();
  return { id: mapping.id };
}

/**
 * Promotes a draft mapping to `negotiating` via the per-mapping open
 * endpoint. After this call the mapping is visible to program reps.
 */
export async function openNegotiation(mappingId: number): Promise<void> {
  const center = await apiAs(ROLES.CENTER_REP);
  const res = await center.post(apiPath(`/mappings/${mappingId}/open`));
  expect(res.ok(), `open mapping failed: ${res.status()}`).toBeTruthy();
  await center.dispose();
}

/**
 * Deletes every project whose code starts with the suite prefix.
 * Cascades clean up project_mappings, mapping_negotiations, and chat
 * messages along with them.
 */
export async function cleanupByCodePrefix(api?: APIRequestContext): Promise<void> {
  const admin = api ?? (await apiAs(ROLES.ADMIN));
  // No bulk delete endpoint — list, then DELETE per id.
  const res = await admin.get(
    apiPath(`/projects?search=${encodeURIComponent(TEST_CODE_PREFIX)}&limit=200`),
  );
  if (!res.ok()) {
    if (!api) await admin.dispose();
    return;
  }
  const body = (await res.json()) as {
    data: Array<{ id: number; code: string }>;
  };
  for (const p of body.data) {
    if (p.code.startsWith(TEST_CODE_PREFIX)) {
      await admin.delete(apiPath(`/projects/${p.id}`));
    }
  }
  if (!api) await admin.dispose();
}
