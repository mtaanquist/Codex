import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Typing while a scene change is loading (#772). The open scene stays on
// screen until the next one's data lands; words typed into it in that moment
// would be saved there and then vanish from view.

const SCENE_DATA = /__data\.json\?.*scene=/;

/** A story with one chapter and one scene; returns the story's path. */
async function newStory(page: Page, name: string) {
	await gotoReady(page, '/');
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`${name}vale`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(/\/universes\//);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `${name}vale`);
	await page.getByLabel('New story').fill(`${name} Book`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(/\/stories\//);
	await page.getByRole('button', { name: 'New chapter' }).click();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	return new URL(page.url()).pathname;
}

/** Holds back each scene's page data so it lands mid-typing. */
async function slowSceneData(page: Page) {
	await page.route(SCENE_DATA, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 800));
		await route.continue();
	});
}

const editor = (page: Page) => page.getByRole('textbox', { name: 'Scene text' });

test('the open scene takes no typing while another scene opens', async ({ page }) => {
	test.slow();
	const storyPath = await newStory(page, `Switch ${Date.now()}`);
	const firstSave = page.waitForResponse(
		(r) => r.url().includes('/api/scenes/') && r.request().method() === 'PUT' && r.ok()
	);
	await editor(page).click();
	await page.keyboard.type('The first scene.');
	await firstSave;
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(2);

	// Opening the story bare shows the scene edited last: the new, empty one.
	await gotoReady(page, storyPath);
	await expect(page.locator('.cm-content')).not.toContainText('The first scene.');

	await slowSceneData(page);
	const strays: string[] = [];
	page.on('request', (r) => {
		if (r.url().includes('/api/scenes/') && r.method() === 'PUT') strays.push(r.postData() ?? '');
	});
	await page.locator('.scene-row', { hasText: '3' }).click();
	await editor(page).click();
	await page.keyboard.type('Typed while it loads.');
	// The keys went nowhere: not into the scene being left (checked at once,
	// before the next scene can replace it)...
	expect(await page.locator('.cm-content').textContent()).not.toContain('Typed while it loads.');
	// ...and the next scene opens as it was.
	await expect(page.locator('.cm-content')).toContainText('The first scene.');
	await expect(page.locator('.cm-content')).not.toContainText('Typed while it loads.');
	await page.waitForTimeout(1500);
	expect(strays.filter((body) => body.includes('Typed while it loads.'))).toEqual([]);

	// Once it has opened, typing works as usual.
	await editor(page).click();
	await page.keyboard.press('ControlOrMeta+End');
	const saved = page.waitForResponse(
		(r) =>
			r.url().includes('/api/scenes/') &&
			r.request().method() === 'PUT' &&
			r.ok() &&
			(r.request().postData() ?? '').includes('Then more.')
	);
	await page.keyboard.type(' Then more.');
	await saved;
});

test('clicking the open scene keeps what is typed straight after', async ({ page }) => {
	test.slow();
	const storyPath = await newStory(page, `Same ${Date.now()}`);
	// Open the story without naming the scene, as the Write link does.
	await gotoReady(page, storyPath);
	await expect(editor(page)).toBeVisible();

	await slowSceneData(page);
	const text = 'Every word of this survives.';
	const saved = page.waitForResponse(
		(r) =>
			r.url().includes('/api/scenes/') &&
			r.request().method() === 'PUT' &&
			r.ok() &&
			(r.request().postData() ?? '').includes(text)
	);
	await page.locator('.scene-row').first().click();
	await editor(page).click();
	await page.keyboard.type(text);
	await expect(page).toHaveURL(/scene=/);
	await expect(page.locator('.cm-content')).toContainText(text);
	await saved;

	await page.unroute(SCENE_DATA);
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText(text);
});
