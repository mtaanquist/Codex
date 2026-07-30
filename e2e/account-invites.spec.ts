import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

// The account Invites section: global-setup grants the e2e user an allowance
// of five and clears unused codes, so the run starts with slots free. The
// test revokes what it makes, keeping repeated runs at the same start.
test('generate, copy-link, and revoke an invite', async ({ page }) => {
	await gotoReady(page, '/account');
	await page.getByRole('link', { name: 'Invites' }).click();
	await expect(page).toHaveURL('/account/invites');
	await expect(page.getByRole('heading', { name: 'Invites', level: 1 })).toBeVisible();

	const rows = page.locator('.list-row');
	const before = await rows.count();
	await page.getByRole('button', { name: 'Generate an invite' }).click();
	await expect(rows).toHaveCount(before + 1);

	// Newest first: the fresh code leads, unused, with its share affordance.
	const row = rows.first();
	await expect(row.locator('.list-sub')).toHaveText('Not used yet');
	await expect(row.getByRole('button', { name: 'Copy link' })).toBeVisible();

	await row.getByRole('button', { name: 'Revoke' }).click();
	await expect(rows).toHaveCount(before);
});
