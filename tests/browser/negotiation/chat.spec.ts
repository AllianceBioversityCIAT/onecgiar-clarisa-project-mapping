import { expect, test } from '@playwright/test';
import { apiAs, apiPath, getConsolidatedEvents, ROLES } from '../fixtures/auth';
import {
  cleanupByCodePrefix,
  createDraftMapping,
  createTestProject,
  openNegotiation,
} from '../fixtures/scenario';

/**
 * Project-level chat messages land in `project_negotiation_messages`
 * and surface in the consolidated event stream with kind=`message`.
 * They are project-scoped (no mapping id) and append-only.
 */
test.describe('Chat thread', () => {
  test.afterAll(async () => {
    await cleanupByCodePrefix();
  });

  test('center, program, and admin all post chat → events stream gains one row each, ordered by createdAt', async () => {
    const project = await createTestProject({ name: 'Chat thread test' });
    const mapping = await createDraftMapping(project.id, { programId: 1 });
    await openNegotiation(mapping.id);

    const centerApi = await apiAs(ROLES.CENTER_REP);
    const programApi = await apiAs(ROLES.PROGRAM_REP);
    const adminApi = await apiAs(ROLES.ADMIN);

    const before = await getConsolidatedEvents(adminApi, project.id);
    const chatBefore = before.filter((e) => e.kind === 'message').length;

    /* Post one chat message from each role. The chat endpoint is
     * lock-gated; with the project unlocked all three should succeed. */
    const centerMsg = `CENTER:${Date.now()}`;
    const programMsg = `PROGRAM:${Date.now()}`;
    const adminMsg = `ADMIN:${Date.now()}`;

    let res = await centerApi.post(apiPath(`/mappings/projects/${project.id}/chat`), {
      data: { message: centerMsg },
    });
    expect(res.ok(), 'center chat post failed').toBeTruthy();

    res = await programApi.post(apiPath(`/mappings/projects/${project.id}/chat`), {
      data: { message: programMsg },
    });
    expect(res.ok(), 'program chat post failed').toBeTruthy();

    res = await adminApi.post(apiPath(`/mappings/projects/${project.id}/chat`), {
      data: { message: adminMsg },
    });
    expect(res.ok(), 'admin chat post failed').toBeTruthy();

    const after = await getConsolidatedEvents(adminApi, project.id);
    const chatAfter = after.filter((e) => e.kind === 'message');

    expect(chatAfter.length).toBe(chatBefore + 3);

    /* The three messages must appear in order of posting. */
    const messages = chatAfter.map((e) => e.message);
    const centerIdx = messages.indexOf(centerMsg);
    const programIdx = messages.indexOf(programMsg);
    const adminIdx = messages.indexOf(adminMsg);
    expect(centerIdx).toBeGreaterThanOrEqual(0);
    expect(programIdx).toBeGreaterThan(centerIdx);
    expect(adminIdx).toBeGreaterThan(programIdx);

    await centerApi.dispose();
    await programApi.dispose();
    await adminApi.dispose();
  });

  test('chat is rejected when the project is locked', async () => {
    const project = await createTestProject({ name: 'Chat lock-gate test' });
    const mapping = await createDraftMapping(project.id, {
      programId: 1,
      allocationPercentage: 100,
    });
    await openNegotiation(mapping.id);

    const centerApi = await apiAs(ROLES.CENTER_REP);
    const programApi = await apiAs(ROLES.PROGRAM_REP);

    await centerApi.post(apiPath(`/mappings/${mapping.id}/agree`), { data: {} });
    await programApi.post(apiPath(`/mappings/${mapping.id}/agree`), { data: {} });
    await centerApi.post(apiPath(`/mappings/projects/${project.id}/lock`));

    const res = await centerApi.post(
      apiPath(`/mappings/projects/${project.id}/chat`),
      { data: { message: 'should be rejected' } },
    );
    expect(res.status()).toBe(403);

    await centerApi.dispose();
    await programApi.dispose();
  });
});
