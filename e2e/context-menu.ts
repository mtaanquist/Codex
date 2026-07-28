import { expect, type Locator, type Page } from '@playwright/test';

// The story outline refreshes in place after a create, rename, or move, so a
// right-click can land on a row that is in the middle of being replaced. The
// click goes to the outgoing node, the menu never opens, and the test waits out
// its timeout on a menu item that was never rendered. Reopening a context menu
// has no side effect, so retry until it is actually on screen.
//
// Returns the open menu, to be scoped into for the item wanted. Only for the
// outline rows; the editor's own context menus are not subject to this refresh.
export async function openRowMenu(page: Page, row: Locator): Promise<Locator> {
	const menu = page.locator('.row-menu');
	await expect(async () => {
		await row.click({ button: 'right' });
		await expect(menu).toBeVisible();
	}).toPass({ timeout: 15_000 });
	return menu;
}
