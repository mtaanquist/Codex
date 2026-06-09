import { expect, test } from '@playwright/test';

test('account settings: rename and see the current session', async ({ page }) => {
	await page.goto('/');

	await page.getByLabel('Account menu').click();
	await page.getByRole('menuitem', { name: 'Account settings' }).click();
	await expect(page).toHaveURL('/account');
	// The sidebar shows who is signed in.
	await expect(page.getByRole('complementary').getByText('e2e@example.com')).toBeVisible();

	// Profile is the default section; a fixed name keeps repeated runs idempotent.
	await page.getByLabel('Display name').fill('E2E Tester');
	await page.getByLabel('Pen name').fill('E. Tester');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');

	// The top-right avatar opens the account menu; Esc closes it.
	const avatar = page.getByRole('button', { name: 'Account menu' });
	await expect(avatar).toHaveAttribute('aria-expanded', 'false');
	await avatar.click();
	await expect(avatar).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('menuitem', { name: 'Account settings' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(avatar).toHaveAttribute('aria-expanded', 'false');

	// The avatar-menu theme toggle persists across a reload, not just the current
	// view (regression: it used to write only localStorage, so the next
	// server-rendered navigation reverted it).
	await avatar.click();
	const wasDark = (await page.locator('html').getAttribute('data-theme')) === 'dark';
	const toggleTo = wasDark ? 'light' : 'dark';
	const themeSave = page.waitForResponse((r) => r.url().includes('/api/appearance') && r.ok());
	await page.getByRole('menuitem', { name: `Switch to ${toggleTo}` }).click();
	await themeSave;
	await expect(page.locator('html')).toHaveAttribute('data-theme', toggleTo);
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', toggleTo);

	// Sessions live under Security, on its own page; the signed-in device
	// shows as current.
	await page.getByRole('link', { name: 'Security' }).click();
	await expect(page).toHaveURL(/\/account\/security$/);
	await expect(page.getByText('Current', { exact: true })).toBeVisible();

	// A made-up section is a clean 404, not an empty page.
	const bogus = await page.request.get('/account/nonsense');
	expect(bogus.status()).toBe(404);

	// Display: the notification matrix saves a per-kind channel choice and
	// reads it back. The admin-only row is absent for a regular account.
	await page.getByRole('link', { name: 'Display' }).click();
	const replyEmail = page.getByLabel('Replies to your review comments by email');
	await expect(page.getByLabel('New accounts awaiting approval in app')).toHaveCount(0);
	await replyEmail.uncheck();
	await page.getByRole('button', { name: 'Save notifications' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
	await expect(replyEmail).not.toBeChecked();
	await replyEmail.check();
	await page.getByRole('button', { name: 'Save notifications' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');

	// A saved theme applies app-wide via the data-theme attribute.
	await page.getByLabel('Theme').selectOption('dark');
	await page.getByRole('button', { name: 'Save display' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

	// Reset so repeated runs start from a known theme.
	await page.getByLabel('Theme').selectOption('system');
	await page.getByRole('button', { name: 'Save display' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
});

test('account assistant: kill switch, identity, and endpoint persist', async ({ page }) => {
	await page.goto('/account/assistant');
	await expect(page.getByRole('heading', { name: 'Assistant', level: 1 })).toBeVisible();

	// The real checkbox is a zero-size hidden input behind the toggle track, so
	// drive it by clicking the wrapping label (the visible switch); toggle-xl is
	// unique to this control. The status span (one element, exact text) reads the
	// state back without the substring ambiguity a loose getByText would hit.
	const killToggle = page.locator('label.toggle-xl');
	const status = page.locator('.ks-status');
	const gated = page.locator('[data-ai-gated]');

	// Normalize to off first: this test mutates account state, and a prior retry
	// may have left the Assistant on.
	await expect(status).toBeVisible();
	if ((await status.textContent())?.trim() === 'Assistant on') await killToggle.click();
	await expect(status).toHaveText('Assistant off');
	await expect(gated).toHaveClass(/off/);

	// Turning the kill switch off enables the Assistant; the toggle auto-submits
	// and the page reloads with the config lit up.
	await killToggle.click();
	await expect(status).toHaveText('Assistant on');
	await expect(gated).not.toHaveClass(/off/);

	// Identity saves a name and tone and reads them back after a reload. Exact
	// labels: "Name" otherwise also matches "Display name" and "Pen name".
	await page.getByLabel('Name', { exact: true }).fill('Margin');
	await page.getByLabel('Style', { exact: true }).selectOption('concise');
	await page.getByRole('button', { name: 'Save identity' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
	await page.reload();
	await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Margin');

	// Endpoint saves a base URL; the saved key hint only appears once a key is set.
	await page.getByLabel('Base URL', { exact: true }).fill('http://ollama.local:11434/v1');
	await page.getByRole('button', { name: 'Save endpoint' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
	await page.reload();
	await expect(page.getByLabel('Base URL', { exact: true })).toHaveValue(
		'http://ollama.local:11434/v1'
	);

	// Turn it back off so repeated runs start from the known default.
	await killToggle.click();
	await expect(status).toHaveText('Assistant off');
});

// Lives in this file (not its own spec) so it never runs concurrently with the
// kill-switch test above: both mutate the shared account Assistant state, and
// tests within one file run serially.
test('assistant tab: gated by the account switch and muted per story', async ({ page }) => {
	const killToggle = page.locator('label.toggle-xl');
	const status = page.locator('.ks-status');

	// Configure an endpoint and turn the Assistant on (no network: nothing is
	// sent until a message is actually asked).
	await page.goto('/account/assistant');
	await page.getByLabel('Base URL', { exact: true }).fill('http://ollama.local:11434/v1');
	await page.getByRole('button', { name: 'Save endpoint' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');
	if ((await status.textContent())?.trim() === 'Assistant off') await killToggle.click();
	await expect(status).toHaveText('Assistant on');

	// A throwaway story to open the editor against.
	const universeName = `AI gate ${Date.now()}`;
	await page.goto('/');
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Gatekeeper');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Gatekeeper');
	const storyUrl = page.url();

	// With the account on, the Assistant tab shows; opening it reveals the chat.
	const tab = page.locator('.rtab', { hasText: 'Assistant' });
	await expect(tab).toBeVisible();
	await tab.click();
	await expect(page.getByPlaceholder('Ask about your story...')).toBeVisible();

	// Muting subtracts the chat but keeps the tab as the un-mute switch.
	await page.getByRole('button', { name: 'Mute for this story' }).click();
	await expect(page.locator('.assistant-muted')).toBeVisible();
	await expect(tab).toBeVisible();
	await page.getByRole('button', { name: 'Turn on for this story' }).click();
	await expect(page.getByPlaceholder('Ask about your story...')).toBeVisible();

	// Turning the account switch off removes the tab entirely (gated, not greyed).
	await page.goto('/account/assistant');
	await killToggle.click();
	await expect(status).toHaveText('Assistant off');
	await page.goto(storyUrl);
	await expect(page.locator('.story-title')).toHaveText('Gatekeeper');
	await expect(page.locator('.rtab', { hasText: 'Assistant' })).toHaveCount(0);
});
