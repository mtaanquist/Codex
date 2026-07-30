import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

test('help: browse the index and open an article', async ({ page }) => {
	await gotoReady(page, '/');

	await gotoReady(page, '/docs');
	await expect(page.getByRole('heading', { name: 'Help', level: 1 })).toBeVisible();
	// Help is a page in the chrome, not a bare page: the bar is there, the path
	// starts at Help, and the article list is the left pane.
	await expect(page.getByRole('navigation', { name: 'Where you are' })).toContainText('Help');
	const topics = page.getByRole('navigation', { name: 'Help topics' });
	await expect(topics.getByRole('link')).not.toHaveCount(0);

	await page
		.getByRole('main')
		.getByRole('link', { name: /Writing in the editor/ })
		.click();
	await expect(page).toHaveURL('/docs/editor');
	await expect(
		page.getByRole('heading', { name: 'Writing in the editor', level: 1 })
	).toBeVisible();
	// The open article is ticked in the list, and the path names it.
	await expect(topics.getByRole('link', { name: 'Writing in the editor' })).toHaveAttribute(
		'aria-current',
		'page'
	);
	await expect(page.getByRole('navigation', { name: 'Where you are' })).toContainText(
		'Writing in the editor'
	);
});

test('help: the question mark is a place, and takes you back out', async ({ page }) => {
	await gotoReady(page, '/');

	// The tool navigates to help rather than opening a modal over your work.
	await page.getByRole('link', { name: /^Help:/ }).click();
	await expect(page).toHaveURL(/^.*\/docs(\/|$)/);
	await expect(page.getByRole('dialog')).toHaveCount(0);

	// While you are there it lights up, and pressing it again returns you.
	const lit = page.getByRole('link', { name: /Help is open/ });
	await expect(lit).toHaveAttribute('aria-current', 'page');
	await lit.click();
	await expect(page).toHaveURL('/');
});
