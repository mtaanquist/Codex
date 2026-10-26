import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Its own account (seeded by global-setup, emptied every run), since the Recent
// row depends on how many stories the library holds.
test.use({ storageState: { cookies: [], origins: [] } });

test('library: tinted placeholder covers, the cover colour, and the Recent row', async ({
	page
}) => {
	await gotoReady(page, '/login');
	await page.getByLabel('Email').fill('library-e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page).toHaveURL('/');

	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill('Coverdale');
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL('/universes/coverdale');

	await gotoReady(page, '/');
	await startStoryInUniverse(page, 'Coverdale');
	await page.getByLabel('New story').fill('Tinted One');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL('/stories/tinted-one');

	// One story: no Recent row repeating it, and a tinted cover that carries the
	// title, with the heading kept for assistive technology.
	await gotoReady(page, '/');
	await expect(page.getByRole('heading', { name: 'Recent' })).toHaveCount(0);
	const card = page.locator('.story-card', { hasText: 'Tinted One' });
	await expect(card).toHaveCount(1);
	const cover = card.locator('.shelf-cover-tinted');
	await expect(cover).toHaveText('Tinted One');
	await expect(cover).toHaveAttribute('style', /--cover-tint: var\(--cat-[a-z]+\)/);
	await expect(card.getByRole('heading', { name: 'Tinted One' })).toHaveCount(1);

	// The colour is the author's to change, and it sticks.
	await gotoReady(page, '/stories/tinted-one/settings');
	const colour = page.getByLabel('Cover colour');
	const next = (await colour.inputValue()) === 'var(--cat-teal)' ? 'Rose' : 'Teal';
	await colour.selectOption({ label: next });
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText('Saved.');
	await page.reload();
	await expect(page.getByLabel('Cover colour')).toHaveValue(`var(--cat-${next.toLowerCase()})`);
	await gotoReady(page, '/');
	await expect(
		page.locator('.story-card', { hasText: 'Tinted One' }).locator('.shelf-cover-tinted')
	).toHaveAttribute('style', new RegExp(`--cat-${next.toLowerCase()}`));

	// More stories than the strip holds: Recent appears, newest first.
	for (const title of ['Tinted Two', 'Tinted Three', 'Tinted Four']) {
		await gotoReady(page, '/');
		await startStoryInUniverse(page, 'Coverdale');
		await page.getByLabel('New story').fill(title);
		await page.getByRole('button', { name: 'Create story' }).click();
		await expect(page).toHaveURL(/\/stories\/tinted-/);
	}
	await gotoReady(page, '/');
	await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
	await expect(page.locator('.recent-row .story-card')).toHaveCount(3);
	await expect(page.locator('.recent-row .story-card').first()).toContainText('Tinted Four');
});
