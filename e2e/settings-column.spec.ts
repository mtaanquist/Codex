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
