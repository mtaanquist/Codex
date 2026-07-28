import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

test('help: browse the index and open an article', async ({ page }) => {
	await gotoReady(page, '/');

	await gotoReady(page, '/docs');
	await expect(page.getByRole('heading', { name: 'Help', level: 1 })).toBeVisible();

	await page.getByRole('link', { name: /Writing in the editor/ }).click();
	await expect(page).toHaveURL('/docs/editor');
	await expect(
		page.getByRole('heading', { name: 'Writing in the editor', level: 1 })
	).toBeVisible();
});
