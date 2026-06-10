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

	// Turn the Assistant on first: the endpoint config below the kill switch is
	// dimmed and not interactable while it is off. Then set an endpoint (no
	// network: nothing is sent until a message is actually asked). The tab needs
	// both an endpoint and the master on.
	await page.goto('/account/assistant');
	if ((await status.textContent())?.trim() === 'Assistant off') await killToggle.click();
	await expect(status).toHaveText('Assistant on');
	await page.getByLabel('Base URL', { exact: true }).fill('http://ollama.local:11434/v1');
	await page.getByRole('button', { name: 'Save endpoint' }).click();
	await expect(page.getByRole('status')).toContainText('Saved');

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
	// The click retries: right after the create-story navigation the page may
	// not be hydrated yet, and a pre-hydration click goes nowhere.
	const tab = page.locator('.rtab', { hasText: 'Assistant' });
	await expect(tab).toBeVisible();
	await expect(async () => {
		await tab.click();
		await expect(page.getByPlaceholder('Ask about your story...')).toBeVisible({ timeout: 2000 });
	}).toPass();

	// The recap and summary actions live in the menu next to the send button;
	// the header keeps the mute link.
	await page.getByRole('button', { name: 'More actions' }).click();
	await expect(page.getByRole('menuitem', { name: 'Catch me up' })).toBeVisible();
	await expect(page.getByRole('menuitem', { name: 'Update summaries' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('menuitem', { name: 'Catch me up' })).toHaveCount(0);

	// With the Assistant live, a text selection's right-click menu offers an
	// Assistant submenu; asking about the selection puts a reference chip into
	// the chat composer, removable before sending.
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	await page.keyboard.type('The gate stood open.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	await page.keyboard.press('ControlOrMeta+a');
	await page.locator('.cm-content').click({ button: 'right' });
	await expect(page.locator('.sel-menu')).toBeVisible();
	await page.locator('.sel-menu').getByRole('menuitem', { name: 'Assistant' }).hover();
	await page
		.locator('.sel-submenu')
		.getByRole('menuitem', { name: 'Ask the Assistant about this' })
		.click();
	await expect(page.locator('.sel-menu')).not.toBeVisible();
	await expect(page.locator('.ref-chip')).toContainText('The gate stood open.');
	await page.getByRole('button', { name: 'Remove the reference' }).click();
	await expect(page.locator('.ref-chip')).toHaveCount(0);

	// The sidebar row menu groups its assistant actions the same way.
	await page.locator('.scene-row').first().click({ button: 'right' });
	await expect(page.locator('.row-menu')).toBeVisible();
	await page.locator('.row-menu').getByRole('menuitem', { name: 'Assistant' }).hover();
	await expect(
		page.locator('.row-submenu').getByRole('menuitem', { name: 'Review this scene' })
	).toBeVisible();
	await expect(
		page.locator('.row-submenu').getByRole('menuitem', { name: 'Suggest where to split' })
	).toBeVisible();
	await page.keyboard.press('Escape');

	// The Write panel captures where the cursor sits as a removable reference,
	// so "continue from here" has something to continue from.
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.locator('.md-coauthor').click();
	await expect(page.locator('.coauthor-ref')).toContainText('Continuing from:');
	await expect(page.locator('.coauthor-ref')).toContainText('The gate stood open.');
	await page.getByRole('button', { name: 'Remove the reference' }).click();
	await expect(page.locator('.coauthor-ref')).toHaveCount(0);
	await page.locator('.coauthor-x').click();

	// The command palette carries the Assistant's quick actions while it is on.
	await page.keyboard.press('ControlOrMeta+k');
	await expect(page.locator('.palette')).toBeVisible();
	await expect(page.locator('.palette-item', { hasText: 'Catch me up' })).toBeVisible();
	await expect(page.locator('.palette-item', { hasText: 'Review this scene' })).toBeVisible();
	await page.keyboard.press('Escape');

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

	// And the menus carry no Assistant entries while it is off.
	await expect(page.locator('.cm-content')).toBeVisible();
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.locator('.cm-content').click({ button: 'right' });
	await expect(page.locator('.sel-menu')).toBeVisible();
	await expect(page.locator('.sel-menu').getByRole('menuitem', { name: 'Assistant' })).toHaveCount(
		0
	);
	await page.keyboard.press('Escape');
	await page.locator('.scene-row').first().click({ button: 'right' });
	await expect(page.locator('.row-menu')).toBeVisible();
	await expect(page.locator('.row-menu').getByRole('menuitem', { name: 'Assistant' })).toHaveCount(
		0
	);
	await page.keyboard.press('Escape');

	// And the palette drops the Assistant commands.
	await page.keyboard.press('ControlOrMeta+k');
	await expect(page.locator('.palette')).toBeVisible();
	await expect(page.locator('.palette-item', { hasText: 'Focus mode' })).toBeVisible();
	await expect(page.locator('.palette-item', { hasText: 'Catch me up' })).toHaveCount(0);
});
