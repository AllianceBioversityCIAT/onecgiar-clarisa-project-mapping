import { expect, test } from '@playwright/test';
import { apiAs, apiPath, loginAs, ROLES } from '../fixtures/auth';
import {
  cleanupByCodePrefix,
  createDraftMapping,
  createTestProject,
  openNegotiation,
} from '../fixtures/scenario';

/**
 * TOC Contribution browser tests — modal flow.
 *
 * All tests reflect the new UX where TOC data is collected inside a
 * p-dialog modal rather than an inline section in the allocation pane:
 *
 *  1. Program rep clicks Agree on a proposal → TOC modal opens (TOC links
 *     missing) → fills AOW + Output → confirms → mapping flips to agreed.
 *  2. Agreed mapping shows the edit TOC icon on the program ROW
 *     (allocation pane) for the program rep → clicking opens the modal
 *     pre-populated → edit → save → toast.
 *  3. Center rep sees a "View TOC" TOC icon on the program ROW
 *     (allocation pane) → clicking opens the modal in read-only mode
 *     (chips, no save button).
 *  4. Locked project: no TOC icon on the program row, Agree button
 *     not visible (locked rounds hide all action buttons).
 *
 * Prerequisites:
 *  - The API must have TOC data seeded (toc_aows / toc_outputs / toc_outcomes
 *    populated for PROGRAM_ID=1). If the tables are empty the GET /toc/*
 *    endpoints return [] and tests that check option counts will be skipped.
 *  - browser-test-program@codeobia.com must be a program_rep for programId=1.
 *  - browser-test-center@codeobia.com must be a center_rep for centerId=1.
 *
 * NOTE: Tests that require a live backend use conditional test.skip() guards
 * so the suite degrades gracefully when the backend is not yet deployed.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seeds TOC links on a mapping via the API.
 * Returns false if the endpoint is not available (skip guard).
 */
async function seedTocLinks(mappingId: number): Promise<boolean> {
  const programApi = await apiAs(ROLES.PROGRAM_REP);

  const aowsRes = await programApi.get(apiPath(`/toc/aows?programId=1`));
  if (!aowsRes.ok()) {
    await programApi.dispose();
    return false;
  }
  const aows = (await aowsRes.json()) as Array<{ id: number }>;
  if (aows.length === 0) {
    await programApi.dispose();
    return false;
  }

  const outputsRes = await programApi.get(apiPath(`/toc/outputs?programId=1&aowIds=${aows[0].id}`));
  if (!outputsRes.ok()) {
    await programApi.dispose();
    return false;
  }
  const outputs = (await outputsRes.json()) as Array<{ id: number }>;
  if (outputs.length === 0) {
    await programApi.dispose();
    return false;
  }

  const patchRes = await programApi.patch(apiPath(`/mappings/${mappingId}/toc-links`), {
    data: { aowIds: [aows[0].id], outputIds: [outputs[0].id], outcomeIds: [] },
  });
  await programApi.dispose();
  return patchRes.ok();
}

// ---------------------------------------------------------------------------
// Suite 1 — Agree opens modal when TOC links are missing
// ---------------------------------------------------------------------------

test.describe('TOC modal — Agree triggers modal when TOC links are missing', () => {
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

  test('program rep clicking Agree opens TOC modal when links are not saved', async ({ page }) => {
    await loginAs(page, ROLES.PROGRAM_REP);
    await page.goto(`/mappings/project/${projectId}`);

    // Wait for the proposal card to appear.
    const agreeBtn = page.getByRole('button', { name: /^agree$/i }).first();
    await expect(agreeBtn).toBeVisible({ timeout: 15_000 });

    // Button should now be ENABLED (no disabled+tooltip pattern).
    await expect(agreeBtn).toBeEnabled();

    // Click it — TOC modal should open.
    await agreeBtn.click();
    const dialog = page.locator('.toc-modal');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Dialog header should say "TOC Contribution".
    await expect(dialog.locator('.p-dialog-title')).toContainText('TOC Contribution');

    // Three multi-selects should be visible (AOW, Outputs, Outcomes).
    await expect(dialog.locator('p-multiselect')).toHaveCount(3, { timeout: 10_000 });

    // Confirm button should be "Save & Agree".
    await expect(dialog.locator('p-button[label="Save & Agree"], button:has-text("Save & Agree")')).toBeVisible();
  });

  test(
    'program rep fills AOW + Output in modal, confirms → mapping flips to agreed',
    async ({ page }) => {
      // Skip if TOC reference data is not available.
      const programApi = await apiAs(ROLES.PROGRAM_REP);
      const aowsRes = await programApi.get(apiPath(`/toc/aows?programId=1`));
      if (!aowsRes.ok()) {
        await programApi.dispose();
        test.skip();
        return;
      }
      const aows = (await aowsRes.json()) as Array<{ id: number; wpOfficialCode: string }>;
      if (aows.length === 0) {
        await programApi.dispose();
        test.skip();
        return;
      }
      const outputsRes = await programApi.get(
        apiPath(`/toc/outputs?programId=1&aowIds=${aows[0].id}`),
      );
      if (!outputsRes.ok()) {
        await programApi.dispose();
        test.skip();
        return;
      }
      const outputs = (await outputsRes.json()) as Array<{ id: number; title: string }>;
      if (outputs.length === 0) {
        await programApi.dispose();
        test.skip();
        return;
      }
      await programApi.dispose();

      await loginAs(page, ROLES.PROGRAM_REP);
      await page.goto(`/mappings/project/${projectId}`);

      const agreeBtn = page.getByRole('button', { name: /^agree$/i }).first();
      await expect(agreeBtn).toBeVisible({ timeout: 15_000 });
      await agreeBtn.click();

      const dialog = page.locator('.toc-modal');
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Select the first AOW in the multi-select.
      const aowSelect = dialog.locator('p-multiselect').first();
      await aowSelect.click();
      const overlay = page.locator('.p-multiselect-overlay').first();
      await expect(overlay).toBeVisible({ timeout: 5_000 });
      // Pick the first option.
      await overlay.locator('.p-multiselect-option').first().click();
      // Close the overlay by clicking elsewhere in the dialog.
      await dialog.locator('.p-dialog-title').click();

      // Wait for Outputs multi-select to be enabled (AOW selection triggers load).
      const outputsSelect = dialog.locator('p-multiselect').nth(1);
      await expect(outputsSelect.locator('.p-multiselect')).not.toHaveClass(/p-disabled/, {
        timeout: 10_000,
      });
      await outputsSelect.click();
      const outputOverlay = page.locator('.p-multiselect-overlay').first();
      await expect(outputOverlay).toBeVisible({ timeout: 5_000 });
      await outputOverlay.locator('.p-multiselect-option').first().click();
      await dialog.locator('.p-dialog-title').click();

      // "Save & Agree" button should now be enabled.
      const confirmBtn = page.getByRole('button', { name: /save & agree/i });
      await expect(confirmBtn).toBeEnabled({ timeout: 5_000 });
      await confirmBtn.click();

      // Dialog should close and the mapping should now show as agreed.
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });
      // Agreed event card should appear in the chat feed.
      await expect(page.locator('.proposal-card__verb').filter({ hasText: /agreed/i })).toBeVisible(
        { timeout: 15_000 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Suite 2 — Edit pencil on agreed events
// ---------------------------------------------------------------------------

test.describe('TOC modal — edit pencil on agreed event cards', () => {
  let projectId: number;
  let mappingId: number;

  test.beforeAll(async () => {
    projectId = (await createTestProject()).id;
    mappingId = (await createDraftMapping(projectId)).id;
    await openNegotiation(mappingId);

    // Seed TOC links and agree from both sides.
    const seeded = await seedTocLinks(mappingId);
    if (!seeded) return;

    const centerApi = await apiAs(ROLES.CENTER_REP);
    await centerApi.post(apiPath(`/mappings/${mappingId}/agree`), { data: {} });
    await centerApi.dispose();

    const programApi = await apiAs(ROLES.PROGRAM_REP);
    await programApi.post(apiPath(`/mappings/${mappingId}/agree`), { data: {} });
    await programApi.dispose();
  });

  test.afterAll(async () => {
    await cleanupByCodePrefix();
  });

  test('program row shows TOC TOC icon for program rep (unlocked project)', async ({
    page,
  }) => {
    // Skip if we couldn't reach the backend in beforeAll.
    const api = await apiAs(ROLES.ADMIN);
    const viewRes = await api.get(apiPath(`/mappings/projects/${projectId}/consolidated`));
    if (!viewRes.ok()) {
      await api.dispose();
      test.skip();
      return;
    }
    const view = (await viewRes.json()) as { mappings: Array<{ status: string }> };
    await api.dispose();
    if (!view.mappings.some((m) => m.status === 'agreed')) {
      // Agreement didn't happen (TOC gate, etc.) — skip.
      test.skip();
      return;
    }

    await loginAs(page, ROLES.PROGRAM_REP);
    await page.goto(`/mappings/project/${projectId}`);

    // The allocation pane program row renders the TOC icon for TOC edit.
    // The row actions section only renders when the project is unlocked.
    const programRow = page.locator('.program-row__actions').first();
    await expect(programRow).toBeVisible({ timeout: 15_000 });

    const tocBtn = programRow.locator('button[ptooltip="Edit TOC contribution"], button[aria-label="Edit TOC contribution"]');
    await expect(tocBtn).toBeVisible({ timeout: 5_000 });

    // Click it — modal should open in edit mode ("Save" button, not "Save & Agree").
    await tocBtn.click();
    const dialog = page.locator('.toc-modal');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /^save$/i })).toBeVisible();
    // Should NOT have "Save & Agree" button.
    await expect(page.getByRole('button', { name: /save & agree/i })).not.toBeVisible();

    // Close modal.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });

  test('edit modal saves updated TOC links and shows success toast', async ({ page }) => {
    // Skip if agreed mapping is not set up.
    const api = await apiAs(ROLES.ADMIN);
    const viewRes = await api.get(apiPath(`/mappings/projects/${projectId}/consolidated`));
    if (!viewRes.ok()) {
      await api.dispose();
      test.skip();
      return;
    }
    const view = (await viewRes.json()) as { mappings: Array<{ status: string }> };
    await api.dispose();
    if (!view.mappings.some((m) => m.status === 'agreed')) {
      test.skip();
      return;
    }

    // Check that TOC reference data is available.
    const programApi = await apiAs(ROLES.PROGRAM_REP);
    const aowsRes = await programApi.get(apiPath(`/toc/aows?programId=1`));
    await programApi.dispose();
    if (!aowsRes.ok() || (await aowsRes.json() as unknown[]).length === 0) {
      test.skip();
      return;
    }

    await loginAs(page, ROLES.PROGRAM_REP);
    await page.goto(`/mappings/project/${projectId}`);

    // Locate the TOC TOC button on the program row in the allocation pane.
    const programRow = page.locator('.program-row__actions').first();
    await expect(programRow).toBeVisible({ timeout: 15_000 });

    const tocBtn = programRow.locator('button[ptooltip="Edit TOC contribution"], button[aria-label="Edit TOC contribution"]');
    await expect(tocBtn).toBeVisible({ timeout: 5_000 });
    await tocBtn.click();

    const dialog = page.locator('.toc-modal');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The Save button should be enabled (existing links satisfy minimum).
    const saveBtn = page.getByRole('button', { name: /^save$/i });
    await expect(saveBtn).toBeEnabled({ timeout: 10_000 });
    await saveBtn.click();

    // Toast should show "Saved" or "TOC contribution updated".
    await expect(page.locator('.p-toast-message')).toBeVisible({ timeout: 8_000 });
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Center rep "View TOC" read-only affordance
// ---------------------------------------------------------------------------

test.describe('TOC modal — center rep can view TOC links (read-only)', () => {
  let projectId: number;
  let mappingId: number;

  test.beforeAll(async () => {
    projectId = (await createTestProject()).id;
    mappingId = (await createDraftMapping(projectId)).id;
    await openNegotiation(mappingId);

    // Seed TOC links and agree from both sides.
    const seeded = await seedTocLinks(mappingId);
    if (!seeded) return;

    const centerApi = await apiAs(ROLES.CENTER_REP);
    await centerApi.post(apiPath(`/mappings/${mappingId}/agree`), { data: {} });
    await centerApi.dispose();

    const programApi = await apiAs(ROLES.PROGRAM_REP);
    await programApi.post(apiPath(`/mappings/${mappingId}/agree`), { data: {} });
    await programApi.dispose();
  });

  test.afterAll(async () => {
    await cleanupByCodePrefix();
  });

  test('center rep sees "View TOC" TOC icon on the program row', async ({ page }) => {
    const api = await apiAs(ROLES.ADMIN);
    const viewRes = await api.get(apiPath(`/mappings/projects/${projectId}/consolidated`));
    if (!viewRes.ok()) {
      await api.dispose();
      test.skip();
      return;
    }
    const view = (await viewRes.json()) as { mappings: Array<{ status: string; tocLinks?: { aows: unknown[] } }> };
    await api.dispose();
    if (!view.mappings.some((m) => m.status === 'agreed' && m.tocLinks && m.tocLinks.aows.length > 0)) {
      test.skip();
      return;
    }

    await loginAs(page, ROLES.CENTER_REP);
    await page.goto(`/mappings/project/${projectId}`);

    // The View TOC TOC button lives on the program row in the allocation pane,
    // NOT on the agreed event card in the chat pane.
    const programRow = page.locator('.program-row').first();
    await expect(programRow).toBeVisible({ timeout: 15_000 });

    const viewTocBtn = programRow.locator('button[ptooltip="View TOC contribution"], button[aria-label="View TOC contribution"]');
    await expect(viewTocBtn).toBeVisible({ timeout: 5_000 });
  });

  test('center rep clicking "View TOC" icon opens readonly modal with chips, no save button', async ({
    page,
  }) => {
    const api = await apiAs(ROLES.ADMIN);
    const viewRes = await api.get(apiPath(`/mappings/projects/${projectId}/consolidated`));
    if (!viewRes.ok()) {
      await api.dispose();
      test.skip();
      return;
    }
    const view = (await viewRes.json()) as { mappings: Array<{ status: string; tocLinks?: { aows: unknown[] } }> };
    await api.dispose();
    if (!view.mappings.some((m) => m.status === 'agreed' && m.tocLinks && m.tocLinks.aows.length > 0)) {
      test.skip();
      return;
    }

    await loginAs(page, ROLES.CENTER_REP);
    await page.goto(`/mappings/project/${projectId}`);

    // The View TOC TOC button is on the program row in the allocation pane.
    const programRow = page.locator('.program-row').first();
    await expect(programRow).toBeVisible({ timeout: 15_000 });

    const viewTocBtn = programRow.locator('button[ptooltip="View TOC contribution"], button[aria-label="View TOC contribution"]');
    await expect(viewTocBtn).toBeVisible({ timeout: 5_000 });
    await viewTocBtn.click();

    const dialog = page.locator('.toc-modal');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Read-only mode: no multi-selects, no save button, chips are visible.
    await expect(dialog.locator('p-multiselect')).not.toBeVisible();
    await expect(page.getByRole('button', { name: /save/i })).not.toBeVisible();
    // Should show at least one AOW chip.
    await expect(dialog.locator('.toc-chip-group')).toBeVisible({ timeout: 5_000 });

    // Close via X.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Locked project: no pencil, no Agree-opens-modal path
// ---------------------------------------------------------------------------

test.describe('TOC modal — locked project hides edit affordances', () => {
  let projectId: number;
  let mappingId: number;

  test.beforeAll(async () => {
    projectId = (await createTestProject()).id;
    mappingId = (await createDraftMapping(projectId)).id;
    await openNegotiation(mappingId);

    // Seed TOC links and agree from both sides to enable locking.
    const seeded = await seedTocLinks(mappingId);
    if (!seeded) return;

    const centerApi = await apiAs(ROLES.CENTER_REP);
    await centerApi.post(apiPath(`/mappings/${mappingId}/agree`), { data: {} });
    await centerApi.dispose();

    const programApi = await apiAs(ROLES.PROGRAM_REP);
    const agreeRes = await programApi.post(apiPath(`/mappings/${mappingId}/agree`), { data: {} });
    await programApi.dispose();
    if (!agreeRes.ok()) return;

    const lockApi = await apiAs(ROLES.CENTER_REP);
    await lockApi.post(apiPath(`/mappings/projects/${projectId}/lock`), { data: {} });
    await lockApi.dispose();
  });

  test.afterAll(async () => {
    await cleanupByCodePrefix();
  });

  test('locked project: no edit pencil visible for program rep', async ({ page }) => {
    const api = await apiAs(ROLES.ADMIN);
    const viewRes = await api.get(apiPath(`/mappings/projects/${projectId}/consolidated`));
    if (!viewRes.ok()) {
      await api.dispose();
      test.skip();
      return;
    }
    const view = (await viewRes.json()) as { isLocked: boolean };
    await api.dispose();
    if (!view.isLocked) {
      test.skip();
      return;
    }

    await loginAs(page, ROLES.PROGRAM_REP);
    await page.goto(`/mappings/project/${projectId}`);

    // Program rows should not show the TOC edit icon on a locked round
    // (the actions block is hidden entirely when isLocked() is true).
    await expect(page.locator('.program-row__actions button[ptooltip="Edit TOC contribution"], .program-row__actions button[aria-label="Edit TOC contribution"]')).not.toBeVisible({ timeout: 10_000 });
  });

  test('locked project: Agree button not visible (locked rounds hide action buttons)', async ({
    page,
  }) => {
    const api = await apiAs(ROLES.ADMIN);
    const viewRes = await api.get(apiPath(`/mappings/projects/${projectId}/consolidated`));
    if (!viewRes.ok()) {
      await api.dispose();
      test.skip();
      return;
    }
    const view = (await viewRes.json()) as { isLocked: boolean };
    await api.dispose();
    if (!view.isLocked) {
      test.skip();
      return;
    }

    await loginAs(page, ROLES.PROGRAM_REP);
    await page.goto(`/mappings/project/${projectId}`);

    // canReplyTo() returns false on locked rounds so no Agree button renders.
    await expect(page.getByRole('button', { name: /^agree$/i })).not.toBeVisible({
      timeout: 10_000,
    });
  });
});
