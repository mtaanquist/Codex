import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';
import { clickTool } from './toolbar';
import { openRowMenu } from './context-menu';

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

test('a failed save asks before switching, and staying keeps the scene editable', async ({
	page
}) => {
	test.slow();
	await newStory(page, `Offline ${Date.now()}`);
	const firstUrl = page.url();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await expect(page).not.toHaveURL(firstUrl);
	const secondUrl = page.url();
	await gotoReady(page, firstUrl);

	let puts = 0;
	await page.route('**/api/scenes/**', (route) => {
		if (route.request().method() !== 'PUT') return route.continue();
		puts++;
		return route.fulfill({ status: 503, body: 'down' });
	});
	const dialogs: string[] = [];
	page.on('dialog', (dialog) => {
		dialogs.push(dialog.message());
		// Cancel: stay on the scene.
		void dialog.dismiss();
	});
	await editor(page).click();
	await page.keyboard.type('Held here.');
	await page.locator('.scene-row').nth(1).click();

	// One save attempt and a question, not a loop; the scene stays and still types.
	await expect.poll(() => dialogs.length).toBe(1);
	expect(dialogs[0]).toContain('could not be saved');
	await page.waitForTimeout(1000);
	expect(puts).toBeLessThan(4);
	await expect(page).toHaveURL(firstUrl);
	await expect(page.locator('.editor.is-leaving')).toHaveCount(0);
	await editor(page).click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(' Still here.');
	await expect(page.locator('.cm-content')).toContainText('Held here. Still here.');

	// Once saving works again, the switch goes through with nothing lost.
	await page.unroute('**/api/scenes/**');
	await page.locator('.scene-row').nth(1).click();
	await expect(page).toHaveURL(secondUrl);
	await gotoReady(page, firstUrl);
	await expect(page.locator('.cm-content')).toContainText('Held here. Still here.');
});

test('the scene takes no typing while a split is on its way', async ({ page }) => {
	test.slow();
	await newStory(page, `Split ${Date.now()}`);
	await editor(page).click();
	await page.keyboard.type('First half.');
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	await page.keyboard.type('Second half.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await page.keyboard.press('Home');

	await page.route('**/api/scenes/*/split', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 800));
		await route.continue();
	});
	await clickTool(page, 'Split scene at cursor');
	await editor(page).click();
	await page.keyboard.type('Typed mid-split.');
	expect(await page.locator('.cm-content').textContent()).not.toContain('Typed mid-split.');

	// The split lands as usual, and neither half picked up the stray keys.
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await expect(page.locator('.cm-content')).toContainText('Second half.');
	await expect(page.locator('.cm-content')).not.toContainText('Typed mid-split.');
	await page.locator('.scene-row').nth(0).click();
	await expect(page.locator('.cm-content')).toContainText('First half.');
	await expect(page.locator('.cm-content')).not.toContainText('Typed mid-split.');
	await expect(page.locator('.cm-content')).not.toContainText('Second half.');
});

test('words typed in the whole-story view are saved before a scene opens', async ({ page }) => {
	test.slow();
	const storyPath = await newStory(page, `Flow ${Date.now()}`);
	const sceneUrl = page.url();
	await gotoReady(page, `${sceneUrl}&view=story`);
	await expect(page).toHaveURL(new RegExp(`${storyPath}.*view=story`));
	const docEditor = page.locator('.doc-scene').first().locator('.cm-content');
	await docEditor.click();
	await page.keyboard.type('Written in the flow.');
	// Straight to the scene on its own, before the typing pause would save it.
	await page.locator('.doc-scene-mark').first().click();
	await expect(page).not.toHaveURL(/view=story/);
	await expect(page.locator('.cm-content')).toContainText('Written in the flow.');
	await expect(page.getByRole('button', { name: /Keep mine/ })).toHaveCount(0);
});

/** A story with two scenes, the first open; returns both scene URLs. */
async function twoScenes(page: Page, name: string) {
	await newStory(page, name);
	const firstUrl = page.url();
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await expect(page).not.toHaveURL(firstUrl);
	const secondUrl = page.url();
	await gotoReady(page, firstUrl);
	return { firstUrl, secondUrl };
}

test('a save that fails on its way out still holds the switch', async ({ page }) => {
	test.slow();
	const { firstUrl } = await twoScenes(page, `Late ${Date.now()}`);
	await page.route('**/api/scenes/**', async (route) => {
		if (route.request().method() !== 'PUT') return route.continue();
		await new Promise((resolve) => setTimeout(resolve, 800));
		await route.fulfill({ status: 503, body: 'down' });
	});
	const dialogs: string[] = [];
	page.on('dialog', (dialog) => {
		dialogs.push(dialog.message());
		void dialog.dismiss();
	});
	await editor(page).click();
	const sent = page.waitForRequest((r) => r.url().includes('/api/scenes/') && r.method() === 'PUT');
	await page.keyboard.type('Sent but not stored.');
	// Switch while that save is still on its way.
	await sent;
	await page.locator('.scene-row').nth(1).click();
	await expect.poll(() => dialogs.length).toBe(1);
	await expect(page).toHaveURL(firstUrl);
	await expect(page.locator('.cm-content')).toContainText('Sent but not stored.');
});

test('a duplicate includes the words typed just before it', async ({ page }) => {
	test.slow();
	await newStory(page, `Copy ${Date.now()}`);
	await editor(page).click();
	await page.keyboard.type('Copied in full.');
	await (
		await openRowMenu(page, page.locator('.scene-row').nth(0))
	)
		.getByRole('menuitem', { name: 'Duplicate scene' })
		.click();
	await expect(page.locator('.scene-row')).toHaveCount(2);
	await expect(page.locator('.cm-content')).toContainText('Copied in full.');
});

test('Back straight after typing saves first and keeps Forward', async ({ page }) => {
	test.slow();
	const { firstUrl, secondUrl } = await twoScenes(page, `Hist ${Date.now()}`);
	await page.locator('.scene-row').nth(1).click();
	await expect(page).toHaveURL(secondUrl);
	await editor(page).click();
	await page.keyboard.type('Before going back.');
	await page.goBack();
	await expect(page).toHaveURL(firstUrl);
	await page.goForward();
	await expect(page).toHaveURL(secondUrl);
	await expect(page.locator('.cm-content')).toContainText('Before going back.');
});
