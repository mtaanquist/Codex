import { expect, test } from '@playwright/test';
import { gotoReady } from './navigate';

// Times render on the author's clock on the server too, so the server's HTML
// and the hydrated page agree (#766). Auckland is far enough from UTC that a
// server-timezone render would show a different hour.
test.use({ timezoneId: 'Pacific/Auckland' });

test('server-rendered times use the browser timezone once it is known', async ({
	page,
	context
}) => {
	await gotoReady(page, '/account/security');
	// The root layout reports the zone on the first visit.
	await expect
		.poll(async () => (await context.cookies()).find((c) => c.name === 'codex-tz')?.value)
		.toBe(encodeURIComponent('Pacific/Auckland'));

	// The server's HTML now carries the Auckland time, and the page, first
	// rendered before the zone was known, re-renders to match it.
	const html = await (await page.request.get('/account/security')).text();
	const rendered = html.match(/Last active ([^<]+)</)?.[1].trim();
	expect(rendered).toBeTruthy();
	await expect(page.locator('.user-row-email', { hasText: 'Last active' }).first()).toHaveText(
		`Last active ${rendered}`
	);

	// And it is the zone that moved it: the same page rendered for UTC shows a
	// different time.
	const session = (await context.cookies()).filter((c) => c.name !== 'codex-tz');
	const utcHtml = await (
		await page.request.get('/account/security', {
			headers: {
				cookie: [...session.map((c) => `${c.name}=${c.value}`), 'codex-tz=UTC'].join('; ')
			}
		})
	).text();
	const utcRendered = utcHtml.match(/Last active ([^<]+)</)?.[1].trim();
	expect(utcRendered).toBeTruthy();
	expect(utcRendered).not.toBe(rendered);
});
