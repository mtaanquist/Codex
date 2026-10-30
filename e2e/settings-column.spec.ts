import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';

async function box(page: Page, selector: string) {
	return page.locator(selector).evaluate((el) => {
		const { left, right, width } = el.getBoundingClientRect();
		return { left, right, width };
	});
}

// On a wide screen the settings column sits next to the sidebar instead of
// floating in the middle, and short fields stop short of the column.
test('settings column is anchored to the sidebar and capped', async ({ page }) => {
	await page.setViewportSize({ width: 1920, height: 1080 });
	await gotoReady(page, '/account');

	const sidebar = await box(page, '.admin-sidebar');
	const column = await box(page, '.admin-main-inner');
	expect(column.left).toBeCloseTo(sidebar.right, 0);
	expect(column.width).toBeLessThanOrEqual(720);

	// The column has 44px of padding either side.
	const name = await box(page, '#display-name');
	expect(name.width).toBeLessThan(column.width - 88);
});

async function rect(page: Page, selector: string) {
	return page
		.locator(selector)
		.first()
		.evaluate((el) => {
			const { left, top, right } = el.getBoundingClientRect();
			return { left, top, right };
		});
}

// A setting's label sits beside its control when the column has room, and
// above it when it does not.
test('settings rows put the label beside the control on wide screens', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoReady(page, '/account');
	const label = await rect(page, 'label[for="display-name"]');
	const control = await rect(page, '#display-name');
	expect(label.right).toBeLessThanOrEqual(control.left);
	expect(Math.abs(label.top - control.top)).toBeLessThan(16);

	await page.setViewportSize({ width: 560, height: 900 });
	const stackedLabel = await rect(page, 'label[for="display-name"]');
	const stackedControl = await rect(page, '#display-name');
	expect(stackedControl.top).toBeGreaterThan(stackedLabel.top + 10);
	expect(Math.abs(stackedLabel.left - stackedControl.left)).toBeLessThan(2);
});

// The long sections list their groups in the sidebar, and a link jumps there.
test('security lists its groups under "On this page"', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await gotoReady(page, '/account/security');
	const contents = page.getByRole('navigation', { name: 'On this page' });
	await expect(contents.getByRole('link')).toHaveText([
		'Email',
		'Password',
		'Two-factor authentication',
		'Passkeys',
		'Sessions',
		'Your data',
		'Delete account'
	]);
	await contents.getByRole('link', { name: 'Sessions' }).click();
	await expect(page).toHaveURL(/#security-sessions$/);
	await expect(page.getByRole('heading', { name: 'Sessions', level: 2 })).toBeInViewport();
	await expect(contents.getByRole('link', { name: 'Sessions' })).toHaveAttribute(
		'aria-current',
		'true'
	);
	// Scrolling to another group moves the mark with it.
	await page.evaluate(() => document.getElementById('security-password')?.scrollIntoView());
	await expect(contents.getByRole('link', { name: 'Password' })).toHaveAttribute(
		'aria-current',
		'true'
	);
	await expect(contents.getByRole('link', { name: 'Sessions' })).not.toHaveAttribute(
		'aria-current'
	);

	// On a laptop-height window both lists stay, at full row height.
	await page.setViewportSize({ width: 1280, height: 700 });
	await expect(contents).toBeVisible();
	const row = await contents.getByRole('link', { name: 'Email' }).boundingBox();
	expect(row!.height).toBeGreaterThanOrEqual(28);
	// The route list keeps its full height; the contents list gives way.
	await expect(page.getByRole('link', { name: 'Page setup' })).toBeInViewport({ ratio: 0.95 });

	// Where the sidebar stacks above the content, the list is left out.
	await page.setViewportSize({ width: 760, height: 900 });
	await expect(contents).toBeHidden();

	// Sections short enough for one screen have no such list.
	await gotoReady(page, '/account/editor');
	await expect(page.getByRole('navigation', { name: 'On this page' })).toHaveCount(0);
});
