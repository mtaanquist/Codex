import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

// These journeys start signed out; skip the shared session.
test.use({ storageState: { cookies: [], origins: [] } });

// The public face: signed-out visitors get the landing page, its calls to
// action lead into the styled auth screens, and signing in lands in the
// library as before.
test('landing page greets signed-out visitors and leads to sign-in', async ({ page }) => {
	await gotoReady(page, '/');
	await expect(page.getByRole('heading', { name: /Write the story/ })).toBeVisible();
	// The test database leaves sign-up on the default 'approval' mode, so a
	// visitor with no invite code is offered the page.
	await expect(page.getByRole('link', { name: 'Request access' }).first()).toHaveAttribute(
		'href',
		'/signup'
	);

	// Into the styled sign-in card.
	await page.getByRole('link', { name: 'Sign in' }).first().click();
	await expect(page).toHaveURL('/login');
	await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
	await page.getByLabel('Email').fill('e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();

	// Signed in, the root is the library again.
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
});

// One figure, three postures: the switch changes the panel and nothing else.
test('the posture switch is a real tablist over the one figure', async ({ page }) => {
	await gotoReady(page, '/');

	const strip = page.getByRole('tablist', { name: 'Who is at the desk' });
	const novelist = strip.getByRole('tab', { name: 'Novelist' });
	const worldbuilder = strip.getByRole('tab', { name: 'Worldbuilder' });
	const gameMaster = strip.getByRole('tab', { name: 'Game master' });

	await expect(novelist).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('tabpanel', { name: 'Novelist' })).toContainText(
		'Departure from Halden'
	);

	await worldbuilder.click();
	await expect(worldbuilder).toHaveAttribute('aria-selected', 'true');
	await expect(novelist).toHaveAttribute('aria-selected', 'false');
	await expect(page.getByRole('tabpanel', { name: 'Novelist' })).toHaveCount(0);
	await expect(page.getByRole('tabpanel', { name: 'Worldbuilder' })).toContainText('House Veren');

	// One tab stop and arrows between the tabs, the same contract as the right
	// pane's panel strip.
	await worldbuilder.press('ArrowRight');
	await expect(gameMaster).toBeFocused();
	await expect(gameMaster).toHaveAttribute('aria-selected', 'true');
	await gameMaster.press('Home');
	await expect(novelist).toBeFocused();
	await expect(novelist).toHaveAttribute('aria-selected', 'true');
});

// Every signed-out page wears the one public shell, and its handbook links go
// to articles that exist.
test('the public shell carries the brand, the tools and the footer', async ({ page }) => {
	await gotoReady(page, '/');

	await expect(page.getByRole('link', { name: 'Codex, home' })).toBeVisible();
	await expect(page.getByRole('link', { name: /^Help:/ })).toBeVisible();
	// No path: a signed-out visitor is not anywhere in the library.
	await expect(page.getByRole('navigation', { name: 'Where you are' })).toHaveCount(0);

	await page.getByRole('link', { name: 'run Codex yourself' }).click();
	await expect(page).toHaveURL('/docs/selfhosting');
	await expect(page.getByRole('heading', { name: 'Running Codex yourself' })).toBeVisible();

	// The footer brand is a lockup linking home, from any signed-out page.
	await gotoReady(page, '/login');
	await page
		.getByRole('contentinfo')
		.getByRole('link', { name: 'Codex', exact: true })
		.click();
	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: /Write the story/ })).toBeVisible();
});
