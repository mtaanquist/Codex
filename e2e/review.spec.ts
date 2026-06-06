import { expect, test } from '@playwright/test';

// The full review loop: the author makes a story and a review link, an
// anonymous guest opens it, gives a name, and comments on a scene, then the
// author reads the thread, replies, and resolves it.
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
	await page.goto(`/stories/${storyId}/settings`);
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
	await expect(guest.locator('.manuscript')).toContainText('opinions about this gate');

	await guest.getByRole('button', { name: 'Comment on this scene' }).click();
	await guest.getByPlaceholder('Your comment on this scene').fill('Strong opening, weak hinges.');
	await guest.getByRole('button', { name: 'Comment', exact: true }).click();
	await expect(guest.getByText('Strong opening, weak hinges.')).toBeVisible();

	// Suggest a change on a real text selection: select "opinions" in the
	// manuscript and propose a replacement.
	await guest.evaluate(() => {
		const manuscript = document.querySelector('.manuscript');
		if (!manuscript) throw new Error('no manuscript');
		// The prose may be split across text nodes by Svelte anchors; find the
		// node carrying the target word.
		const walker = document.createTreeWalker(manuscript, NodeFilter.SHOW_TEXT);
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
	await guest.locator('.manuscript').dispatchEvent('mouseup');
	await guest.getByRole('button', { name: 'Suggest a change' }).click();
	await guest.getByLabel('Suggested text').fill('reservations');
	await guest.getByRole('button', { name: 'Suggest', exact: true }).click();
	await expect(guest.locator('.suggestion ins')).toHaveText('reservations');
	await guestContext.close();

	// Author: the bell heard about both; the comment notification leads to
	// the feedback page. Counts are not asserted because a long-lived local
	// database may carry unread rows from earlier runs.
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

	// Mark everything read; the badge goes quiet. The feedback page has no
	// topbar, so this happens back on the library.
	await page.goto('/');
	await page.getByRole('button', { name: /^Notifications/ }).click();
	await page.getByRole('button', { name: 'Mark all read' }).click();
	await expect(page.locator('.bell-badge')).toHaveCount(0);
	await page.keyboard.press('Escape');

	// The thread is on the feedback page; reply and resolve.
	await page.goto(`/stories/${storyId}/review`);
	await expect(page.getByText('Strong opening, weak hinges.')).toBeVisible();
	await expect(page.getByText('Margin Walker -')).toBeVisible();
	await page.getByLabel('Reply').fill('Noted; oiling the hinges.');
	await page.getByRole('button', { name: 'Reply', exact: true }).click();
	await expect(page.getByText('Noted; oiling the hinges.')).toBeVisible();
	await page.getByRole('button', { name: 'Resolve' }).click();
	await expect(page.getByText('Resolved', { exact: true })).toBeVisible();

	// Accept the suggested change: the prose updates in place.
	await expect(page.locator('.suggestion ins')).toHaveText('reservations');
	await page.getByRole('button', { name: 'Accept' }).click();
	await expect(page.getByText('Accepted')).toBeVisible();
	await expect(page.locator('.manuscript')).toContainText(
		'The reviewer will have reservations about this gate.'
	);

	// A revoked link stops working for new visits.
	await page.goto(`/stories/${storyId}/settings`);
	await page.getByRole('button', { name: 'Revoke' }).click();
	await expect(page.getByText('Revoked')).toBeVisible();
	const lateContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const late = await lateContext.newPage();
	await late.goto(link!);
	await expect(late.getByRole('heading', { name: 'This review has ended' })).toBeVisible();
	await lateContext.close();
});
