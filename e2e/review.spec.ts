import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// The full review loop: the author makes a story and a review link, an
// anonymous guest opens it, gives a name, comments on a scene and suggests an
// edit, then the author reads the thread on the review workspace, replies,
// accepts the edit, and resolves the thread.
test('guest review: invite, comment as a guest, reply and resolve as the author', async ({
	page,
	browser
}) => {
	// Author: a fresh story with one scene of prose.
	await gotoReady(page, '/');

	const universeName = `Review Test ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(universeName);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${universeName} - settings`);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, universeName);
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
	await gotoReady(page, `/stories/${storyId}/settings/review`);
	await page.getByLabel('Who is this link for? (optional)').fill('e2e guest');
	await page.getByRole('button', { name: 'Create review link' }).click();
	const link = await page.locator('.review-link code').textContent();
	expect(link).toMatch(/^\/review\//);

	// Guest: a clean context with no session.
	const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const guest = await guestContext.newPage();
	await gotoReady(guest, link!);
	await guest.getByLabel('Your name').fill('Margin Walker');
	await guest.getByLabel('Email (optional)').fill('margin@example.com');
	await guest.getByRole('button', { name: 'Start reviewing' }).click();
	// The guest shell: the same bar with the parts a reviewer has no use for
	// removed, and the parts they were missing (theme, help) put back.
	await expect(guest.getByText('Reviewing as Margin Walker')).toBeVisible();
	await expect(guest.locator('.appbar.guest')).toBeVisible();
	await expect(guest.getByRole('navigation', { name: 'Where you are' })).toContainText(
		'Review only'
	);
	await expect(guest.getByRole('button', { name: /^Theme:/ })).toBeVisible();
	await expect(guest.getByRole('link', { name: 'Help: reviewing' })).toBeVisible();
	// No search, no bell, no account menu for someone without an account.
	await expect(guest.getByRole('button', { name: 'Search and commands' })).toHaveCount(0);
	await expect(guest.getByRole('button', { name: 'Account menu' })).toHaveCount(0);
	await expect(guest.locator('.review-prose')).toContainText('opinions about this gate');

	// A guest cannot leave review mode: the strip keeps all four modes, three
	// switched off in place, and one line under it says why.
	const modes = guest.locator('.mode-strip .seg-btn');
	await expect(modes).toHaveCount(4);
	for (const mode of ['Write', 'Plan', 'Notes']) {
		await expect(modes.filter({ hasText: mode })).toHaveAttribute('aria-disabled', 'true');
	}
	await expect(guest.locator('.mode-note')).toContainText('belong to the author');

	// One panel applies to a reviewer, so their pane wears the panel's title
	// rather than a one-segment strip, with the Open/Done filter inside it.
	await expect(guest.locator('.panel-strip')).toHaveCount(0);
	await expect(guest.locator('.panel-head-title')).toHaveText('Comments');
	await expect(guest.locator('.rv-panel-head .seg-btn', { hasText: 'Open' })).toBeVisible();

	// A whole-scene comment from the panel.
	await guest.getByRole('button', { name: 'On the whole scene' }).click();
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

	// The guest can open a discussion on their own pending suggestion; the
	// reply renders on the card. No assistant is involved on the guest page.
	const guestSugg = guest.locator('.rv-card.sugg');
	await guestSugg.getByLabel('Reply', { exact: true }).fill('Softer than opinions, I think.');
	await guestSugg.getByRole('button', { name: 'Send reply' }).click();
	await expect(guestSugg.locator('.rv-reply-body')).toHaveText('Softer than opinions, I think.');
	await guestContext.close();

	// Author: the bell heard about both; the comment notification leads to the
	// review page. Counts are not asserted because a long-lived local database
	// may carry unread rows from earlier runs.
	await gotoReady(page, '/');
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
	// The suggestion card carries its own reply field now, so the comment
	// thread's is reached through its card.
	await expect(page.locator('.rv-body', { hasText: 'Strong opening, weak hinges.' })).toBeVisible();
	const commentCard = page.locator('.rv-card').filter({ hasText: 'Strong opening, weak hinges.' });
	await expect(commentCard).toBeVisible();
	await commentCard.getByLabel('Reply', { exact: true }).fill('Noted; oiling the hinges.');
	await commentCard.getByRole('button', { name: 'Send reply' }).click();
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
	await page.locator('.rv-panel-head .seg-btn', { hasText: 'Done' }).click();
	await expect(page.locator('.rv-status.resolved')).toBeVisible();
	await expect(page.locator('.rv-status.accepted')).toBeVisible();

	// Clicking the accepted edit points at where it landed: a faint outline over
	// the replacement text in the manuscript (decided suggestions get a display
	// anchor, not just the open ones).
	await page.locator('.rv-card').filter({ hasText: 'reservations' }).first().click();
	await expect(page.locator('.review-edit .cm-content .rv-resolved')).toBeVisible();

	// A revoked link stops working for new visits.
	await gotoReady(page, `/stories/${storyId}/settings/review`);
	await page.getByRole('button', { name: 'Revoke' }).click();
	await expect(page.getByText('Revoked')).toBeVisible();
	const lateContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const late = await lateContext.newPage();
	await gotoReady(late, link!);
	await expect(late.getByRole('heading', { name: 'This review has ended' })).toBeVisible();
	await lateContext.close();
});
