import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu } from './library';

// The Plan sidebar shows one Add row per group instead of an open field for
// each; a row opens its field, Escape closes it, and a rejected name reopens
// the field with the reason.
test('plan sidebar add rows open one field at a time', async ({ page }) => {
	await gotoReady(page, '/');
	const universeName = `Sidebar universe ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await gotoReady(page, `${new URL(page.url()).pathname}/plan`);

	const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
	await expect(sidebar.locator('form.new-entity')).toHaveCount(0);
	await expect(sidebar.getByRole('button', { name: 'Add Lore entry' })).toBeVisible();
	await expect(sidebar.getByRole('button', { name: 'Add Faction entry' })).toBeVisible();
	await expect(sidebar.getByRole('link', { name: 'Manage categories' })).toHaveAttribute(
		'href',
		/\/categories$/
	);

	// A row opens one focused field; opening another closes the first.
	await sidebar.getByRole('button', { name: 'Add character' }).click();
	await expect(sidebar.getByLabel('Character name')).toBeFocused();
	await sidebar.getByRole('button', { name: 'Add place' }).click();
	await expect(sidebar.getByLabel('Place name')).toBeFocused();
	await expect(sidebar.getByLabel('Character name')).toHaveCount(0);

	// Escape closes it and returns to the row.
	await page.keyboard.press('Escape');
	await expect(sidebar.locator('form.new-entity')).toHaveCount(0);
	await expect(sidebar.getByRole('button', { name: 'Add place' })).toBeFocused();

	// A blank name gets past the browser check but not the server; the field
	// comes back with the message.
	await sidebar.getByRole('button', { name: 'Add character' }).click();
	await sidebar.getByLabel('Character name').fill('   ');
	await sidebar.getByLabel('Character name').press('Enter');
	await expect(sidebar.getByRole('alert')).toHaveText('Give the character a name.');
	await expect(sidebar.getByLabel('Character name')).toBeVisible();

	// Escape works from the submit button too, and reopening drops the old message.
	await sidebar.getByRole('button', { name: 'Add character' }).last().focus();
	await page.keyboard.press('Escape');
	await expect(sidebar.locator('form.new-entity')).toHaveCount(0);
	await sidebar.getByRole('button', { name: 'Add character' }).click();
	await expect(sidebar.getByRole('alert')).toHaveCount(0);

	// A real name creates the entry.
	await sidebar.getByLabel('Character name').fill('Maren');
	await sidebar.getByLabel('Character name').press('Enter');
	await expect(page).toHaveURL(/entity=/);
	await expect(sidebar.locator('.ent-row', { hasText: 'Maren' })).toHaveCount(1);

	// The message and its field are in the server render, so they show
	// before scripts load.
	const planUrl = new URL(page.url());
	const response = await page.request.post(`${planUrl.pathname}?/createCharacter`, {
		form: { name: '   ' },
		headers: { origin: planUrl.origin, accept: 'text/html' }
	});
	const html = await response.text();
	expect(html).toContain('Give the character a name.');
	expect(html).toContain('id="add-character"');
});
