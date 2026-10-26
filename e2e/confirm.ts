import { type Page } from '@playwright/test';

// Destructive actions ask first in the app's own confirm prompt (an
// alertdialog), not the browser's. These answer it.

/** Clicks the prompt's go-ahead button, named by its verb ("Delete scene"). */
export async function confirmPrompt(page: Page, label: string) {
	await page.getByRole('alertdialog').getByRole('button', { name: label, exact: true }).click();
}

/** Accepts any prompt that appears from here on, for steps that ask only
 * sometimes (switching provider asks only when something would be cleared). */
export async function acceptPrompts(page: Page) {
	const prompt = page.getByRole('alertdialog');
	await page.addLocatorHandler(prompt, async () => {
		await prompt.locator('.confirm-ok').click();
	});
}
