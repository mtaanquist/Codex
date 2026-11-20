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

	await page.keyboard.press('Home');
	expect(await width(page, '.pane.left')).toBeCloseTo(264, 0);
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Enter');
	expect(await width(page, '.pane.left')).toBeCloseTo(264, 0);

	// A plain click is not a drag: the default stays window-relative.
	await handle.dblclick();
	await handle.click();
	expect(await page.evaluate(() => localStorage.getItem('codex-right-w'))).toBeNull();
	// The centre paints over the part of the left handle that overlaps it.
	await left.dblclick({ position: { x: 2, y: 100 } });
	expect(await width(page, '.pane.right')).toBeCloseTo(312, 0);
	expect(await width(page, '.pane.left')).toBeCloseTo(264, 0);
});

// A stored width carries its own floor and cap, which may be hand-edited or
// older than the current bounds; only the chosen width is trusted. The settings
// rail reads the same left width, and a double-tap resets like a double-click.
test('stored widths are re-bounded, shared with settings, and reset by double-tap', async ({
	page
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoReady(page, '/account');
	await page.evaluate(() => {
		localStorage.setItem('codex-left-w', 'clamp(10px, 50px, 90vw)');
		localStorage.setItem('codex-right-w', 'clamp(10px, 1400px, 99vw)');
	});
	await page.reload();
	expect(await width(page, '.admin-sidebar')).toBeCloseTo(264, 0);
	await page.evaluate(() => localStorage.setItem('codex-left-w', 'clamp(264px, 400px, 30vw)'));
	await page.reload();
	expect(await width(page, '.admin-sidebar')).toBeCloseTo(400, 0);

	await gotoReady(page, '/');
	const universeName = `Bounds ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universeName);
	await page.getByLabel('New story').fill('Bounds');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Bounds');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await expect(page.locator('.pane.right')).toBeVisible();
	expect(await width(page, '.pane.left')).toBeCloseTo(400, 0);
	// The stored 1400px meets the real cap, 40% of the window.
	expect(await width(page, '.pane.right')).toBeCloseTo(576, 0);

	const tap = (name: string) =>
		page.getByRole('separator', { name }).evaluate((el) => {
			const init = { pointerType: 'touch', pointerId: 7, button: 0, bubbles: true };
			el.dispatchEvent(new PointerEvent('pointerdown', init));
			el.dispatchEvent(new PointerEvent('pointerup', init));
		});
	// One tap alone changes nothing.
	await tap('Resize the left sidebar');
	expect(await width(page, '.pane.left')).toBeCloseTo(400, 0);
	await tap('Resize the left sidebar');
	expect(await width(page, '.pane.left')).toBeCloseTo(264, 0);
	expect(await page.evaluate(() => localStorage.getItem('codex-left-w'))).toBeNull();
});
