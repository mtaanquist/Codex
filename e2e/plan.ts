import { expect, type Page } from '@playwright/test';
import { waitForHydration } from './navigate';

// The Plan sidebar shows one "Add" row per group; picking it opens that
// group's name field. These steps are shared by every spec that makes an
// entity, so the specs name the row rather than spelling the clicks out.

/** Opens a Plan sidebar Add row ("Add character", "Add Lore entry"), types the name, and submits. */
export async function addEntity(page: Page, row: string, name: string) {
	await waitForHydration(page);
	await page.getByRole('button', { name: row, exact: true }).click();
	const field = page.locator('form.new-entity input[name="name"]');
	await expect(field).toBeFocused();
	await field.fill(name);
	await field.press('Enter');
}
