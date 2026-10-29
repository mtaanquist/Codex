import { expect, test, type Page } from '@playwright/test';
import { gotoReady } from './navigate';

// The pages a reader, reviewer or new user can reach from a phone, and a
// laptop at 200% zoom, fit the window: no sideways scrolling, and the bar's
// last control is still on screen.

async function expectNoSidewaysScroll(page: Page) {
	const [scrollWidth, innerWidth] = await page.evaluate(() => [
		document.documentElement.scrollWidth,
		window.innerWidth
	]);
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

async function expectInView(page: Page, control: 'account' | 'help') {
	const bar = page.locator('.appbar');
	const target =
		control === 'account'
			? bar.getByRole('button', { name: 'Account menu' })
			: bar.getByRole('link', { name: /^Help/ });
	await expect(target).toBeInViewport({ ratio: 1 });
}

test.describe('at phone width', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('signed-in pages fit and keep the account menu in reach', async ({ page }) => {
		for (const path of ['/', '/docs', '/docs/getting-started']) {
			await gotoReady(page, path);
			await expectNoSidewaysScroll(page);
			await expectInView(page, 'account');
		}
		// The bar keeps the page you are on and a Search icon.
		await gotoReady(page, '/docs/getting-started');
		await expect(page.locator('.path .crumb.current')).toHaveText('Getting started');
		await expect(page.locator('.path a.crumb', { hasText: 'Help' })).toBeVisible();
		await gotoReady(page, '/');
		await expect(page.locator('.path .crumb.current')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Search and commands' })).toBeVisible();
	});

	test.describe('signed out', () => {
		test.use({ storageState: { cookies: [], origins: [] } });

		test('sign-in, help and the public shelf fit', async ({ page }) => {
			for (const path of ['/login', '/docs', '/@e2e-tester']) {
				await gotoReady(page, path);
				await expectNoSidewaysScroll(page);
				await expectInView(page, 'help');
			}
		});
	});
});

test.describe('at 200% zoom on a laptop', () => {
	test.use({ viewport: { width: 720, height: 450 } });

	test('the library and help fit', async ({ page }) => {
		for (const path of ['/', '/docs/getting-started']) {
			await gotoReady(page, path);
			await expectNoSidewaysScroll(page);
			await expectInView(page, 'account');
		}
	});
});
