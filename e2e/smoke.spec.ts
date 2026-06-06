import { expect, test } from '@playwright/test';

// These journeys start signed out; skip the shared session.
test.use({ storageState: { cookies: [], origins: [] } });

test('home page renders', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('the health check answers without a session', async ({ request }) => {
	const response = await request.get('/healthz');
	expect(response.status()).toBe(200);
	expect(await response.json()).toEqual({ status: 'ok' });
});
