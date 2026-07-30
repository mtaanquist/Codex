import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Readable URLs: universes and stories get slugs generated from their
// names, and a rename in settings moves the address along with it.
test('slugs: created things get readable addresses that follow renames', async ({ page }) => {
	await gotoReady(page, '/');

	// The universe lands on a slugged address derived from its name.
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Slugfall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/slugfall-${stamp}`);

	// So does the story.
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Slugfall ${stamp}`);
	await page.getByLabel('New story').fill(`Toll Road ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/toll-road-${stamp}`);

	// Renaming the story in settings moves the address with the title.
	await gotoReady(page, `/stories/toll-road-${stamp}/settings`);
	await page.locator('#st-title').fill(`Toll ${stamp}`);
	await page.locator('#details').getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(`/stories/toll-${stamp}/settings`);

	// The old slug is gone; the new one carries the story.
	const stale = await gotoReady(page, `/stories/toll-road-${stamp}`);
	expect(stale!.status()).toBe(404);
	await gotoReady(page, `/stories/toll-${stamp}`);
	await expect(page.locator('.story-title')).toHaveText(`Toll ${stamp}`);

	// Plan actions redirect back to the slug address, not the id.
	await gotoReady(page, `/stories/toll-${stamp}/plan`);
	await page.getByPlaceholder('New character name').fill('Slug Tester');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page).toHaveURL(new RegExp(`/stories/toll-${stamp}/plan\\?entity=`));

	await gotoReady(page, `/universes/slugfall-${stamp}/plan`);
	await page.getByPlaceholder('New place name').fill('Sluggate');
	await page.getByRole('button', { name: 'Add place' }).click();
	await expect(page).toHaveURL(new RegExp(`/universes/slugfall-${stamp}/plan\\?entity=`));

	// Renaming the universe moves its address too.
	await gotoReady(page, `/universes/slugfall-${stamp}`);
	await page.locator('#u-name').fill(`Slugged ${stamp}`);
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(`/universes/slugged-${stamp}`);
	const staleUniverse = await gotoReady(page, `/universes/slugfall-${stamp}/plan`);
	expect(staleUniverse!.status()).toBe(404);
});
