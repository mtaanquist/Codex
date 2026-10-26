import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoReady, waitForHydration } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Every menu shares one keyboard contract: Enter on the trigger opens it with
// the first item focused, the arrow keys move and wrap, Home and End jump to
// the ends, Escape returns focus to the trigger, and Tab closes it.

async function focused(page: Page): Promise<string> {
	return page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
}

async function openWithKeyboard(trigger: Locator) {
	await trigger.focus();
	await trigger.press('Enter');
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

test('library menus: keyboard open, arrows, Escape and Tab', async ({ page }) => {
	await gotoReady(page, '/');

	const newMenu = page.getByRole('button', { name: 'New', exact: true });
	await openWithKeyboard(newMenu);
	const items = page.getByRole('menu').getByRole('menuitem');
	await expect(items.first()).toBeFocused();
	const count = await items.count();
	const first = await focused(page);
	await page.keyboard.press('ArrowDown');
	await expect(items.nth(1)).toBeFocused();
	await page.keyboard.press('End');
	await expect(items.nth(count - 1)).toBeFocused();
	// Wraps back round to the top.
	await page.keyboard.press('ArrowDown');
	expect(await focused(page)).toBe(first);
	await page.keyboard.press('ArrowUp');
	await expect(items.nth(count - 1)).toBeFocused();
	await page.keyboard.press('Home');
	await expect(items.first()).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(newMenu).toHaveAttribute('aria-expanded', 'false');
	await expect(newMenu).toBeFocused();
	await expect(page.getByRole('menu')).toHaveCount(0);

	// Tab closes the menu and carries on from the trigger, not from <body>.
	await openWithKeyboard(newMenu);
	await page.keyboard.press('Tab');
	await expect(newMenu).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('menu')).toHaveCount(0);
	expect(
		await page.evaluate(() => {
			const active = document.activeElement;
			return !!active && active !== document.body && !active.closest('[role="menu"]');
		})
	).toBe(true);
	await page.keyboard.press('Shift+Tab');
	await expect(newMenu).toBeFocused();

	// The account menu follows the same contract.
	const avatar = page.getByRole('button', { name: 'Account menu' });
	await openWithKeyboard(avatar);
	await expect(page.getByRole('menuitem', { name: 'Account settings' })).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(avatar).toBeFocused();
});

test('story menus: crumb menu and the toolbar overflow', async ({ page }) => {
	await gotoReady(page, '/');
	const universeName = `Menuverse ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universeName);
	await page.getByLabel('New story').fill('Keyboard Tales');
	await page.getByRole('button', { name: 'Create story' }).click();
	await waitForHydration(page);

	const crumb = page
		.getByRole('navigation', { name: 'Where you are' })
		.getByRole('button', { name: 'Keyboard Tales' });
	await openWithKeyboard(crumb);
	await expect(page.getByRole('menuitem', { name: 'Go to the story' })).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('menuitem', { name: 'Go to the story' })).not.toBeFocused();
	await page.keyboard.press('Escape');
	await expect(crumb).toBeFocused();

	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);

	// A narrow window pushes tools into the "More tools" overflow menu.
	await page.setViewportSize({ width: 900, height: 800 });
	const more = page.getByRole('button', { name: 'More tools' });
	await expect(more).toBeVisible();
	// Opened with the mouse, the overflow leaves focus in the editor.
	await page.locator('.cm-content').click();
	await more.click();
	const overflow = page.locator('.md-menu');
	await expect(overflow).toBeVisible();
	await expect(page.locator('.cm-content')).toBeFocused();
	await more.click();
	await expect(overflow).toHaveCount(0);

	// Opened from the keyboard, focus moves to the first item.
	await openWithKeyboard(more);
	await expect(overflow.locator('[role^="menuitem"]').first()).toBeFocused();
	// A toggle from the keyboard closes the menu and hands focus to the editor.
	const toggle = overflow.getByRole('menuitemcheckbox').first();
	const toggleName = (await toggle.textContent())?.trim() ?? '';
	await toggle.focus();
	await page.keyboard.press('Enter');
	await expect(overflow).toHaveCount(0);
	await expect(page.locator('.cm-content')).toBeFocused();
	// Flip it back.
	await openWithKeyboard(more);
	await overflow.getByRole('menuitemcheckbox', { name: toggleName }).click();
	await expect(page.locator('.cm-content')).toBeFocused();

	// Escape from inside the overflow returns to the editor too.
	await overflow.locator('[role^="menuitem"]').first().focus();
	await page.keyboard.press('Escape');
	await expect(overflow).toHaveCount(0);
	await expect(page.locator('.cm-content')).toBeFocused();
});
