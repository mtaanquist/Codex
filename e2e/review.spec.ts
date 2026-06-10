import { expect, test } from '@playwright/test';

// The full review loop: the author makes a story and a review link, an
// anonymous guest opens it, gives a name, comments on a scene and suggests an
// edit, then the author reads the thread on the review workspace, replies,
// accepts the edit, and resolves the thread.
test('guest review: invite, comment as a guest, reply and resolve as the author', async ({
	page,
	browser
}) => {
	// Author: a fresh story with one scene of prose.
	await page.goto('/');

	const universeName = `Review Test ${Date.now()}`;
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: universeName })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill('Margin Notes');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Margin Notes');
	await page.getByRole('button', { name: 'New chapter' }).click();
	await expect(page.locator('.chapter-name')).toHaveText('Chapter 1');
	await page.getByRole('button', { name: 'New scene' }).click();
	await expect(page).toHaveURL(/scene=/);
	await page.locator('.cm-content').click();
	await page.keyboard.type('The reviewer will have opinions about this gate.');
	await expect(page.locator('.saved')).toHaveText(/Saved just now/);
	const storyId = page.url().match(/stories\/([^/?]+)/)![1];

	// Create the review link in settings; it is shown once.
	await page.goto(`/stories/${storyId}/settings/review`);
	await page.getByLabel('Who is this link for? (optional)').fill('e2e guest');
	await page.getByRole('button', { name: 'Create review link' }).click();
	const link = await page.locator('.review-link code').textContent();
	expect(link).toMatch(/^\/review\//);

	// Guest: a clean context with no session.
	const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestContext.newPage();
	await guest.goto(link!);
	await guest.getByLabel('Your name').fill('Margin Walker');
	await guest.getByLabel('Email (optional)').fill('margin@example.com');
	await guest.getByRole('button', { name: 'Start reviewing' }).click();
	await expect(guest.getByText('Reviewing as Margin Walker')).toBeVisible();
	await expect(guest.locator('.review-prose')).toContainText('opinions about this gate');

	// A guest cannot leave review mode: the other tabs are disabled.
	await expect(guest.locator('.seg-btn', { hasText: 'Write' })).toBeDisabled();
	await expect(guest.locator('.seg-btn', { hasText: 'Plan' })).toBeDisabled();

	// A whole-scene comment from the panel.
	await guest.getByRole('button', { name: 'Whole scene' }).click();
	await guest.getByLabel('Your comment').fill('Strong opening, weak hinges.');
	await guest
		.locator('.rv-card.is-draft')
		.getByRole('button', { name: 'Comment', exact: true })
		.click();
	await expect(
		guest.locator('.rv-body', { hasText: 'Strong opening, weak hinges.' })
	).toBeVisible();

	// Suggest a change on a real text selection: select "opinions" in the prose
	// and propose a replacement from the floating toolbar.
	await guest.evaluate(() => {
		const prose = document.querySelector('.review-prose');
		if (!prose) throw new Error('no prose');
		const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node && !(node.textContent ?? '').includes('opinions')) node = walker.nextNode();
		if (!node) throw new Error('target text not found');
		const start = node.textContent!.indexOf('opinions');
		const range = document.createRange();
		range.setStart(node, start);
		range.setEnd(node, start + 'opinions'.length);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await guest.locator('.review-doc').dispatchEvent('mouseup');
	await guest.locator('.rv-seltool').getByRole('button', { name: 'Suggest edit' }).click();
	await guest.getByLabel('Suggested text').fill('reservations');
	await guest.getByRole('button', { name: 'Save suggestion' }).click();
	await expect(guest.locator('.rv-diff-ins')).toHaveText('reservations');
	await guestContext.close();

	// Author: the bell heard about both; the comment notification leads to the
	// review page. Counts are not asserted because a long-lived local database
	// may carry unread rows from earlier runs.
	await page.goto('/');
	await page.getByRole('button', { name: /^Notifications/ }).click();
	const bellMenu = page.locator('.bell-menu');
	await expect(bellMenu).toContainText('Margin Walker commented on "Margin Notes"');
	await expect(bellMenu).toContainText('Margin Walker suggested an edit on "Margin Notes"');
	await expect(bellMenu).toContainText('Strong opening, weak hinges.');
	await bellMenu
		.locator('.bell-item', { hasText: 'Margin Walker commented on "Margin Notes"' })
		.first()
		.click();
	await expect(page).toHaveURL(`/stories/${storyId}/review`);

	// The thread is on the review workspace; reply, accept the edit, resolve.
	await expect(page.locator('.rv-body', { hasText: 'Strong opening, weak hinges.' })).toBeVisible();
	await expect(page.locator('.rv-card').filter({ hasText: 'Margin Walker' }).first()).toBeVisible();
	await page.getByLabel('Reply', { exact: true }).fill('Noted; oiling the hinges.');
	await page.getByRole('button', { name: 'Send reply' }).click();
	await expect(
		page.locator('.rv-reply-body', { hasText: 'Noted; oiling the hinges.' })
	).toBeVisible();

	// Accept the suggested change from the card's header-corner control: the
	// author's editable prose updates in place.
	await expect(page.locator('.rv-diff-ins')).toHaveText('reservations');
	await page.getByRole('button', { name: 'Accept suggestion' }).click();
	await expect(page.locator('.review-edit .cm-content')).toContainText(
		'The reviewer will have reservations about this gate.'
	);

	// Resolve the thread, then the Done filter shows both outcomes.
	await page.getByRole('button', { name: 'Resolve comment' }).click();
	await page.locator('.rv-filter', { hasText: 'Done' }).click();
	await expect(page.locator('.rv-status.resolved')).toBeVisible();
	await expect(page.locator('.rv-status.accepted')).toBeVisible();

	// A revoked link stops working for new visits.
	await page.goto(`/stories/${storyId}/settings/review`);
	await page.getByRole('button', { name: 'Revoke' }).click();
	await expect(page.getByText('Revoked')).toBeVisible();
	const lateContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const late = await lateContext.newPage();
	await late.goto(link!);
	await expect(late.getByRole('heading', { name: 'This review has ended' })).toBeVisible();
	await lateContext.close();
});
