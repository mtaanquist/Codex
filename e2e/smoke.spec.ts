import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

// These journeys start signed out; skip the shared session.
test.use({ storageState: { cookies: [], origins: [] } });

test('home page renders', async ({ page }) => {
	await gotoReady(page, '/');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('the health check answers without a session', async ({ request }) => {
	const response = await request.get('/healthz');
	expect(response.status()).toBe(200);
	expect(await response.json()).toEqual({ status: 'ok' });
});

test('pages send a content security policy the page itself obeys', async ({ page }) => {
	const violations: string[] = [];
	page.on('console', (message) => {
		if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
	});
	await page.addInitScript(() => localStorage.setItem('codex-theme', 'dark'));
	const response = await page.goto('/');
	const csp = response?.headers()['content-security-policy'] ?? '';
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).toContain("script-src 'self' 'nonce-");
	await gotoReady(page, '/');
	// The inline theme script in app.html ran under the policy.
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	expect(violations).toEqual([]);
});
