import { expect, test } from '@playwright/test';

// Issue #305: clicking an entity's badge opens a menu to pick a colour (or
// upload an image, when storage is configured). The colour path always works
// and is remembered.
test('an entity badge can be given a colour from its menu, and it sticks', async ({ page }) => {
	await page.goto('/');
	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Badges ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/badges-${stamp}`);

	await page.goto(`/universes/badges-${stamp}/plan`);
	await page.getByPlaceholder('New character name').fill('Aria');
	await page.getByRole('button', { name: 'Add character' }).click();

	// Open the character; its editor carries the large badge.
	await page.locator('.ent-row', { hasText: 'Aria' }).first().click();
	await expect(page).toHaveURL(/\?entity=/);
	const badge = page.locator('.detail-head .badge.lg');
	await expect(badge).toBeVisible();

	// The badge opens a menu; pick Red.
	await page.locator('.badge-pick-btn').click();
	const saved = page.waitForResponse(
		(r) => r.url().includes('/badge') && r.request().method() === 'PUT' && r.ok()
	);
	await page.getByRole('button', { name: 'Red', exact: true }).click();
	await saved;
	await expect(badge).toHaveAttribute('style', /var\(--cat-red\)/);

	// Remembered: reload and the badge is still red.
	await page.reload();
	await expect(page.locator('.detail-head .badge.lg')).toHaveAttribute('style', /var\(--cat-red\)/);
});
