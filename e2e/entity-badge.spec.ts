import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu } from './library';

// Issue #305: clicking an entity's badge opens a menu to pick a colour (or
// upload an image, when storage is configured). The colour path always works
// and is remembered.
test('an entity badge can be given a colour from its menu, and it sticks', async ({ page }) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Badges ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/badges-${stamp}`);

	await gotoReady(page, `/universes/badges-${stamp}/plan`);
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

// Issue #626: a refused badge change says so and leaves the badge as it was,
// instead of looking saved.
test('a refused badge colour change shows the reason and is undone', async ({ page }) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Refused badges ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/refused-badges-${stamp}`);

	await gotoReady(page, `/universes/refused-badges-${stamp}/plan`);
	await page.getByPlaceholder('New character name').fill('Bram');
	await page.getByRole('button', { name: 'Add character' }).click();
	await page.locator('.ent-row', { hasText: 'Bram' }).first().click();
	await expect(page).toHaveURL(/\?entity=/);
	const badge = page.locator('.detail-head .badge.lg');
	await expect(badge).toBeVisible();

	await page.route('**/api/entities/*/badge', (route) =>
		route.request().method() === 'PUT'
			? route.fulfill({ status: 429, json: { message: 'Too many requests. Try again shortly.' } })
			: route.fallback()
	);
	await page.locator('.badge-pick-btn').click();
	await page.getByRole('button', { name: 'Red', exact: true }).click();
	await expect(page.locator('.badge-menu [role="alert"]')).toHaveText(
		'Too many requests. Try again shortly.'
	);
	await expect(badge).not.toHaveAttribute('style', /var\(--cat-red\)/);
});
