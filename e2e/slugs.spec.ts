import { expect, test } from '@playwright/test';

// Readable URLs: universes and stories get slugs generated from their
// names, and the slug is editable in settings.
test('slugs: created things get readable addresses, editable in settings', async ({ page }) => {
	await page.goto('/');

	// The universe lands on a slugged address derived from its name.
	const stamp = Date.now();
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Slugfall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/slugfall-${stamp}`);

	// So does the story.
	await page.getByLabel('New story').fill(`Toll Road ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/toll-road-${stamp}`);

	// Editing the slug in settings moves the address.
	await page.goto(`/stories/toll-road-${stamp}/settings`);
	await page.getByLabel('Slug').fill(`toll-${stamp}`);
	await page.locator('#details').getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page).toHaveURL(`/stories/toll-${stamp}/settings`);

	// The old slug is gone; the new one carries the story.
	const stale = await page.goto(`/stories/toll-road-${stamp}`);
	expect(stale!.status()).toBe(404);
	await page.goto(`/stories/toll-${stamp}`);
	await expect(page.locator('.story-title')).toHaveText(`Toll Road ${stamp}`);

	// Plan actions redirect back to the slug address, not the id.
	await page.goto(`/stories/toll-${stamp}/plan`);
	await page.getByPlaceholder('New character name').fill('Slug Tester');
	await page.getByRole('button', { name: 'Add character' }).click();
	await expect(page).toHaveURL(new RegExp(`/stories/toll-${stamp}/plan\\?entity=`));

	await page.goto(`/universes/slugfall-${stamp}/plan`);
	await page.getByPlaceholder('New place name').fill('Sluggate');
	await page.getByRole('button', { name: 'Add place' }).click();
	await expect(page).toHaveURL(new RegExp(`/universes/slugfall-${stamp}/plan\\?entity=`));
});
