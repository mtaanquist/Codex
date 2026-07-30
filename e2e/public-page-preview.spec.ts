import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

// Sets the profile visibility toggle on the account page, working whether the
// form saves with a button or on change.
async function setVisibility(page: import('@playwright/test').Page, on: boolean) {
	await gotoReady(page, '/account');
	const toggle = page.locator('input[name="profilePublic"]');
	if ((await toggle.isChecked()) === on) return;
	// The input hides behind the toggle-track skin, so click its label.
	await page.locator('label.toggle', { has: toggle }).click();
	await expect(toggle).toBeChecked({ checked: on });
	const save = page.getByRole('button', { name: 'Save public page' });
	if (await save.isVisible()) await save.click();
	await expect(page.getByRole('status')).toContainText('Saved');
}

// The owner can open their own page as a preview while it is still hidden;
// visitors get no such view. Ends with the profile public, a state no other
// spec depends on.
test('the owner previews their page before it is public', async ({ page, browser }) => {
	await setVisibility(page, false);

	// The owner sees the full header plus the only-you note.
	await gotoReady(page, '/@e2e-tester');
	await expect(page.locator('.preview-note')).toContainText('Only you can see this page');
	await expect(page.locator('.shelf-name')).not.toContainText('@');

	// A visitor gets the page without the preview and without the header
	// details the visibility toggle guards.
	const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const visitor = await anonymous.newPage();
	await gotoReady(visitor, '/@e2e-tester');
	await expect(visitor.locator('.shelf-handle')).toContainText('@e2e-tester');
	await expect(visitor.locator('.preview-note')).toHaveCount(0);
	await expect(visitor.locator('.shelf-bio')).toHaveCount(0);
	await anonymous.close();

	// Turning visibility on removes the note for the owner too.
	await setVisibility(page, true);
	await gotoReady(page, '/@e2e-tester');
	await expect(page.locator('.preview-note')).toHaveCount(0);
});
