import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// On a narrow window (a small laptop window, or 200% zoom) the story editor
// shows one pane at a time, picked from a tab bar under the top bar (#737).

async function expectNoSidewaysScroll(page: Page) {
	const [scrollWidth, innerWidth] = await page.evaluate(() => [
		document.documentElement.scrollWidth,
		window.innerWidth
	]);
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test('the story editor shows one pane at a time on narrow windows', async ({ page }) => {
	test.slow();
	const stamp = Date.now();
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Narrowvale ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(/\/universes\//);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Narrowvale ${stamp}`);
	await page.getByLabel('New story').fill(`Thin Book ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(/\/stories\//);
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	const tabs = page.getByRole('navigation', { name: 'Story panes' });
	const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
	const sidePanel = page.getByRole('complementary', { name: 'Side panel' });
	const editor = page.getByRole('textbox', { name: 'Scene text' });

	// Wide: all three panes, no tab bar.
	await expect(tabs).toBeHidden();
	await expect(sidebar).toBeVisible();
	await expect(sidePanel).toBeVisible();

	for (const width of [720, 390]) {
		await page.setViewportSize({ width, height: 800 });
		await expect(tabs).toBeVisible();
		await expectNoSidewaysScroll(page);
		// The writing is the pane shown first.
		await expect(editor).toBeVisible();
		await expect(sidebar).toBeHidden();
		await expect(sidePanel).toBeHidden();

		await tabs.getByRole('button', { name: 'Side panel' }).click();
		await expect(sidePanel).toBeVisible();
		await expect(editor).toBeHidden();
		await expectNoSidewaysScroll(page);

		await tabs.getByRole('button', { name: 'Scenes' }).click();
		await expect(sidebar).toBeVisible();
		await expect(tabs.getByRole('button', { name: 'Scenes' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expectNoSidewaysScroll(page);

		// Picking a scene from the list goes back to the writing.
		await page.locator('.scene-row').first().click();
		await expect(editor).toBeVisible();
		await expect(sidebar).toBeHidden();
	}

	// The editor still saves at phone width.
	const save = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);
	await editor.click();
	await page.keyboard.type('Written on a narrow window.');
	await save;
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Written on a narrow window.');
});
