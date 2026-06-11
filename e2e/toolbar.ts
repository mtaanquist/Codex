import { type Page } from '@playwright/test';

// The formatting bar collapses any tools that do not fit the width into a "More
// tools" overflow menu, so a tool is reachable either as an inline button or as
// a row in that menu. These helpers hide that split from the specs.

const MORE = 'More tools';

async function inlineVisible(page: Page, name: string | RegExp): Promise<boolean> {
	return page
		.getByRole('button', { name })
		.first()
		.isVisible()
		.catch(() => false);
}

// The formatting overflow menu (scoped so it is never confused with the top-bar
// avatar dropdown, which is also a role="menu").
function overflowMenu(page: Page) {
	return page.locator('.md-menu');
}

async function openOverflow(page: Page) {
	if (await overflowMenu(page).isVisible()) return;
	await page.getByRole('button', { name: MORE }).click();
	await overflowMenu(page).waitFor();
}

async function closeOverflow(page: Page) {
	if (await overflowMenu(page).isVisible()) await page.getByRole('button', { name: MORE }).click();
}

// Click a formatting command (heading, indent, split, ...) by accessible name,
// reaching it through the overflow menu when it has collapsed.
export async function clickTool(page: Page, name: string | RegExp) {
	if (await inlineVisible(page, name)) {
		await page.getByRole('button', { name }).first().click();
		return;
	}
	await openOverflow(page);
	// A command row closes the menu on click.
	await overflowMenu(page).getByRole('menuitem', { name }).first().click();
}

// Toggle a view option (non-printing characters, command markers), inline or in
// the menu. The menu is left closed.
export async function toggleView(page: Page, name: string | RegExp) {
	if (await inlineVisible(page, name)) {
		await page.getByRole('button', { name }).first().click();
		return;
	}
	await openOverflow(page);
	await overflowMenu(page).getByRole('menuitemcheckbox', { name }).first().click();
	await closeOverflow(page);
}

// Whether a view option is currently on, reading either the inline button's
// aria-pressed or the menu row's aria-checked. The menu is left closed.
export async function viewChecked(page: Page, name: string | RegExp): Promise<boolean> {
	if (await inlineVisible(page, name)) {
		const pressed = await page.getByRole('button', { name }).first().getAttribute('aria-pressed');
		return pressed === 'true';
	}
	await openOverflow(page);
	const checked = await overflowMenu(page)
		.getByRole('menuitemcheckbox', { name })
		.first()
		.getAttribute('aria-checked');
	await closeOverflow(page);
	return checked === 'true';
}
