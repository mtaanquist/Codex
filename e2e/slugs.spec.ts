import { expect, test } from '@playwright/test';

// Readable URLs: universes and stories get slugs generated from their
// names, and a rename in settings moves the address along with it.
test('slugs: created things get readable addresses that follow renames', async ({ page }) => {
	await page.goto('/');

	// The universe lands on a slugged address derived from its name.
	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Slugfall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/slugfall-${stamp}`);

	// So does the story.
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Slugfall ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill(`Toll Road ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/toll-road-${stamp}`);

	// Renaming the story in settings moves the address with the title.
	await page.goto(`/stories/toll-road-${stamp}/settings`);
	await page.locator('#st-title').fill(`Toll ${stamp}`);
	await page.locator('#details').getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(`/stories/toll-${stamp}/settings`);

	// The old slug is gone; the new one carries the story.
	const stale = await page.goto(`/stories/toll-road-${stamp}`);
	expect(stale!.status()).toBe(404);
	await page.goto(`/stories/toll-${stamp}`);
	await expect(page.locator('.story-title')).toHaveText(`Toll ${stamp}`);

	// Plan actions redirect back to the slug address, not the id.
	await page.goto(`/stories/toll-${stamp}/plan`);
	await page.getByPlaceholder('New character name').fill('Slug Tester');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page).toHaveURL(new RegExp(`/stories/toll-${stamp}/plan\\?entity=`));

	await page.goto(`/universes/slugfall-${stamp}/plan`);
	await page.getByPlaceholder('New place name').fill('Sluggate');
	await page.getByRole('button', { name: 'Add place' }).click();
	await expect(page).toHaveURL(new RegExp(`/universes/slugfall-${stamp}/plan\\?entity=`));

	// Renaming the universe moves its address too.
	await page.goto(`/universes/slugfall-${stamp}`);
	await page.locator('#u-name').fill(`Slugged ${stamp}`);
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page).toHaveURL(`/universes/slugged-${stamp}`);
	const staleUniverse = await page.goto(`/universes/slugfall-${stamp}/plan`);
	expect(staleUniverse!.status()).toBe(404);
});
