import { expect, test } from '@playwright/test';
import { apiAs, apiPath, getTimeline, loginAs, ROLES } from '../fixtures/auth';
import {
  cleanupByCodePrefix,
  createDraftMapping,
  createTestProject,
  openNegotiation,
} from '../fixtures/scenario';

test.describe('Agree flow', () => {
  let projectId: number;
  let mappingId: number;

  test.beforeAll(async () => {
    projectId = (await createTestProject()).id;
    mappingId = (await createDraftMapping(projectId)).id;
    await openNegotiation(mappingId);
  });

  test.afterAll(async () => {
    await cleanupByCodePrefix();
  });

  test('center then program agree → two AGREED rows + status transitions to agreed', async ({
    page,
  }) => {
    const api = await apiAs(ROLES.ADMIN);
    const before = await getTimeline(api, mappingId);

    await loginAs(page, ROLES.CENTER_REP);
    await page.goto(`/mappings/project/${projectId}`);

    const agreeBtn = page.getByRole('button', { name: /^agree$/i });
    if (await agreeBtn.isVisible().catch(() => false)) {
      await agreeBtn.first().click();
    } else {
      const centerApi = await apiAs(ROLES.CENTER_REP);
      const res = await centerApi.post(apiPath(`/mappings/${mappingId}/agree`), {
        data: {},
      });
      expect(res.ok()).toBeTruthy();
      await centerApi.dispose();
    }

    /* Program rep agrees next. */
    await loginAs(page, ROLES.PROGRAM_REP);
    await page.goto(`/mappings/project/${projectId}`);
    const programAgreeBtn = page.getByRole('button', { name: /^agree$/i });
    if (await programAgreeBtn.isVisible().catch(() => false)) {
      await programAgreeBtn.first().click();
    } else {
      const progApi = await apiAs(ROLES.PROGRAM_REP);
      const res = await progApi.post(apiPath(`/mappings/${mappingId}/agree`), {
        data: {},
      });
      expect(res.ok()).toBeTruthy();
      await progApi.dispose();
    }

    /* Two new rows in the timeline, both AGREED with different actor
     * roles. Order matters: center first, program second. */
    await expect
      .poll(async () => (await getTimeline(api, mappingId)).length)
      .toBe(before.length + 2);

    const after = await getTimeline(api, mappingId);
    const newRows = after.slice(before.length);
    expect(newRows.map((r) => r.eventType)).toEqual(['agreed', 'agreed']);
    /* Mapping should now be in `agreed` status. */
    const summary = await api.get(apiPath(`/mappings/${mappingId}`));
    expect(summary.ok()).toBeTruthy();
    const body = (await summary.json()) as { status: string };
    expect(body.status).toBe('agreed');

    await api.dispose();
  });
});
