import { expect, test } from '@playwright/test';
import { apiAs, apiPath, getTimeline, ROLES } from '../fixtures/auth';
import {
  cleanupByCodePrefix,
  createDraftMapping,
  createTestProject,
  openNegotiation,
} from '../fixtures/scenario';

/**
 * The program-rep removal flow is asymmetric:
 *   program rep → `request-removal`     (REMOVAL_REQUESTED row)
 *   center rep  → `decline-removal`     (REMOVAL_DECLINED row, mapping stays)
 *   OR
 *   center rep  → `remove`               (REMOVED row, mapping leaves)
 *
 * This spec exercises both branches against the API to nail the
 * timeline. UI assertions live in the consolidated-page spec.
 */
test.describe('Removal request flow', () => {
  test.afterAll(async () => {
    await cleanupByCodePrefix();
  });

  test('request → decline keeps the mapping and appends REMOVAL_REQUESTED + REMOVAL_DECLINED', async () => {
    const project = await createTestProject({
      name: 'Removal request — decline branch',
    });
    const mapping = await createDraftMapping(project.id, { programId: 1 });
    await openNegotiation(mapping.id);

    const programApi = await apiAs(ROLES.PROGRAM_REP);
    const centerApi = await apiAs(ROLES.CENTER_REP);
    const adminApi = await apiAs(ROLES.ADMIN);

    /* Request removal */
    const reqRes = await programApi.post(
      apiPath(`/mappings/${mapping.id}/request-removal`),
      { data: { justification: 'no longer in scope' } },
    );
    expect(reqRes.ok()).toBeTruthy();

    let t = await getTimeline(adminApi, mapping.id);
    expect(t[t.length - 1].eventType).toBe('removal_requested');

    /* Decline */
    const declineRes = await centerApi.post(
      apiPath(`/mappings/${mapping.id}/decline-removal`),
      { data: { reason: 'still needed' } },
    );
    expect(declineRes.ok()).toBeTruthy();

    t = await getTimeline(adminApi, mapping.id);
    expect(t[t.length - 1].eventType).toBe('removal_declined');

    /* The mapping should be NOT removed. */
    const refresh = await adminApi.get(apiPath(`/mappings/${mapping.id}`));
    const body = (await refresh.json()) as { status: string };
    expect(body.status).not.toBe('removed');

    await programApi.dispose();
    await centerApi.dispose();
    await adminApi.dispose();
  });

  test('request → accept (center calls /remove) merges justifications into one REMOVED row', async () => {
    const project = await createTestProject({
      name: 'Removal request — accept branch',
    });
    const mapping = await createDraftMapping(project.id, { programId: 1 });
    await openNegotiation(mapping.id);

    const programApi = await apiAs(ROLES.PROGRAM_REP);
    const centerApi = await apiAs(ROLES.CENTER_REP);

    await programApi.post(apiPath(`/mappings/${mapping.id}/request-removal`), {
      data: { justification: 'PROGRAM_SIDE_REASON' },
    });

    const removeRes = await centerApi.post(apiPath(`/mappings/${mapping.id}/remove`), {
      data: { justification: 'CENTER_SIDE_REASON' },
    });
    expect(removeRes.ok()).toBeTruthy();

    const t = await getTimeline(centerApi, mapping.id);
    const last = t[t.length - 1];
    expect(last.eventType).toBe('removed');
    /* Merged justification must contain both sides — protects against
     * accidentally dropping either reason during accept. */
    expect(last.justification).toContain('CENTER_SIDE_REASON');
    expect(last.justification).toContain('PROGRAM_SIDE_REASON');

    await programApi.dispose();
    await centerApi.dispose();
  });
});
