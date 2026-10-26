import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

async function width(page: Page, selector: string) {
	return page.locator(selector).evaluate((el) => el.getBoundingClientRect().width);
}

// The side columns keep their old widths on a laptop and grow on a wide
// screen, and the panel strip's tabs size to their labels.
test('side columns grow on wide screens; panel tabs fit their labels', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoReady(page, '/');
	const universeName = `Columns ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universeName);
	await page.getByLabel('New story').fill('Wide');
	await page.getByRole('button', { name: 'Create story' }).click();
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.locator('.pane.right')).toBeVisible();

	expect(await width(page, '.pane.left')).toBeCloseTo(264, 0);
	expect(await width(page, '.pane.right')).toBeCloseTo(312, 0);
	const reference = await width(page, '.panel-strip [role="tab"]:text-is("Reference")');
	const notes = await width(page, '.panel-strip [role="tab"]:text-is("Notes")');
	expect(reference).toBeGreaterThan(notes);

	await page.setViewportSize({ width: 2000, height: 1100 });
	expect(await width(page, '.pane.left')).toBeCloseTo(300, 0);
	expect(await width(page, '.pane.right')).toBeCloseTo(380, 0);
});
