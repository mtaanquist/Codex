import { type Page } from '@playwright/test';

// The library makes new things from a collection's own header: a New menu in the
// page header, and a New story menu on every universe row. Both open the same
// inline title form, so the specs share these two steps rather than spelling the
// menu out twenty times.

/** Opens the library header's New menu and picks one of its rows. */
export async function pickFromLibraryMenu(page: Page, item: string) {
	await page.getByRole('button', { name: 'New', exact: true }).click();
	await page.getByRole('menuitem', { name: item }).click();
}

/** Opens a universe row's New story menu and picks "New story in <universe>". */
export async function startStoryInUniverse(page: Page, universeName: string) {
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story', exact: true })
		.click();
	await page.getByRole('menuitem', { name: `New story in ${universeName}` }).click();
}
