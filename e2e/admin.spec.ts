import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

// The seeded e2e account is a regular user, so it must not reach the admin
// area. The approve/reject behaviour itself is covered by integration tests.
test('the admin area is hidden from non-admins', async ({ page }) => {
	await gotoReady(page, '/');

	const response = await gotoReady(page, '/admin');
	expect(response?.status()).toBe(404);
});
