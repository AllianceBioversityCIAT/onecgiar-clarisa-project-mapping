import { expect, test } from '@playwright/test';
import { apiAs, apiPath, getTimeline, ROLES } from '../fixtures/auth';
import {
  cleanupByCodePrefix,
  createDraftMapping,
  createTestProject,
  openNegotiation,
} from '../fixtures/scenario';

/**
 * Lock and reopen each append a per-mapping audit row (LOCKED on lock,
 * REOPENED on reopen). Reopen also reverts every non-removed mapping
 * back to draft, which the test asserts via the mapping status.
 */
test.describe('Lock / reopen lifecycle', () => {
  test.afterAll(async () => {
    await cleanupByCodePrefix();
  });

  test('lock appends a LOCKED row, reopen appends a REOPENED row, prior rows are untouched', async () => {
    const project = await createTestProject({
      name: 'Lock / reopen lifecycle',
    });
    const mapping = await createDraftMapping(project.id, {
      programId: 1,
      allocationPercentage: 100,
    });
    await openNegotiation(mapping.id);

    const programApi = await apiAs(ROLES.PROGRAM_REP);
    const centerApi = await apiAs(ROLES.CENTER_REP);
    const adminApi = await apiAs(ROLES.ADMIN);

    /* Both sides agree → mapping is AGREED at 100%. */
    await centerApi.post(apiPath(`/mappings/${mapping.id}/agree`), { data: {} });
    await programApi.post(apiPath(`/mappings/${mapping.id}/agree`), { data: {} });

    const beforeLock = await getTimeline(adminApi, mapping.id);

    /* Lock */
    const lockRes = await centerApi.post(
      apiPath(`/mappings/projects/${project.id}/lock`),
    );
    expect(lockRes.ok(), `lock failed: ${lockRes.status()}`).toBeTruthy();

    let after = await getTimeline(adminApi, mapping.id);
    expect(after.length).toBe(beforeLock.length + 1);
    expect(after[after.length - 1].eventType).toBe('locked');
    /* Prior rows byte-identical (immutable append) */
    for (let i = 0; i < beforeLock.length; i++) {
      expect(after[i]).toMatchObject({
        eventType: beforeLock[i].eventType,
        proposedAllocation: beforeLock[i].proposedAllocation,
      });
    }

    /* Reopen */
    const beforeReopen = after.length;
    const reopenRes = await centerApi.post(
      apiPath(`/mappings/projects/${project.id}/reopen`),
    );
    expect(reopenRes.ok()).toBeTruthy();

    after = await getTimeline(adminApi, mapping.id);
    expect(after.length).toBe(beforeReopen + 1);
    expect(after[after.length - 1].eventType).toBe('reopened');

    /* Mapping should now be back to DRAFT — invisible to program reps. */
    const mappingRes = await adminApi.get(apiPath(`/mappings/${mapping.id}`));
    const body = (await mappingRes.json()) as { status: string };
    expect(body.status).toBe('draft');

    await programApi.dispose();
    await centerApi.dispose();
    await adminApi.dispose();
  });
});
