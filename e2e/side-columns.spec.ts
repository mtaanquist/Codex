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
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universeName);
	await page.getByLabel('New story').fill('Wide');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Wide');
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

// Dragging an edge widens the column, the width survives a reload, the keyboard
// moves it too, and a double-click puts the default back.
test('side columns resize by drag and keyboard, and remember the width', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoReady(page, '/');
	const universeName = `Resize ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universeName);
	await page.getByLabel('New story').fill('Resize');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Resize');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.locator('.pane.right')).toBeVisible();

	const handle = page.getByRole('separator', { name: 'Resize the right sidebar' });
	const box = (await handle.boundingBox())!;
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x - 100, y, { steps: 5 });
	await page.mouse.up();
	expect(await width(page, '.pane.right')).toBeCloseTo(412, 0);

	await page.reload();
	await expect(page.locator('.pane.right')).toBeVisible();
	expect(await width(page, '.pane.right')).toBeCloseTo(412, 0);

	// The cap is 40% of the window.
	await handle.focus();
	await page.keyboard.press('End');
	expect(await width(page, '.pane.right')).toBeCloseTo(576, 0);
	await expect(handle).toHaveAttribute('aria-valuenow', '576');
	await page.keyboard.press('ArrowRight');
	expect(await width(page, '.pane.right')).toBeCloseTo(560, 0);

	const left = page.getByRole('separator', { name: 'Resize the left sidebar' });
	await left.focus();
	await page.keyboard.press('ArrowRight');
	expect(await width(page, '.pane.left')).toBeCloseTo(280, 0);

	await handle.dblclick();
	await left.dblclick();
	expect(await width(page, '.pane.right')).toBeCloseTo(312, 0);
	expect(await width(page, '.pane.left')).toBeCloseTo(264, 0);
});
