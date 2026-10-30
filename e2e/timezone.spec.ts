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

	// The server's HTML now carries the Auckland times, and the page, first
	// rendered before the zone was known, re-renders to match them. Compared
	// as sets, re-fetched until they settle: another spec signing in as this
	// user adds a session row, and the last-seen refresh moves one.
	const domTimes = page.locator('.user-row-email', { hasText: 'Last active' });
	const lastActive = (html: string) =>
		[...html.matchAll(/Last active ([^<]+)</g)].map((m) => m[1].trim());
	let auckland: string[] = [];
	await expect
		.poll(async () => {
			auckland = lastActive(await (await page.request.get('/account/security')).text());
			const shown = (await domTimes.allTextContents()).map((t) =>
				t.replace('Last active', '').trim()
			);
			return shown.length > 0 && shown.every((time) => auckland.includes(time));
		})
		.toBe(true);

	// And it is the zone that moved them: rendered for UTC, every time differs.
	const session = (await context.cookies()).filter((c) => c.name !== 'codex-tz');
	const utc = lastActive(
		await (
			await page.request.get('/account/security', {
				headers: {
					cookie: [...session.map((c) => `${c.name}=${c.value}`), 'codex-tz=UTC'].join('; ')
				}
			})
		).text()
	);
	expect(utc.length).toBeGreaterThan(0);
	expect(utc.filter((time) => auckland.includes(time))).toEqual([]);
});

test('a malformed or unknown timezone cookie renders in UTC, not an error', async ({
	page,
	context
}) => {
	await gotoReady(page, '/account/security');
	const session = (await context.cookies()).filter((c) => c.name !== 'codex-tz');
	// Sent as raw headers, so the server's own cookie parsing sees the bad value.
	const render = async (zone: string) => {
		const response = await page.request.get('/account/security', {
			headers: {
				cookie: [...session.map((c) => `${c.name}=${c.value}`), `codex-tz=${zone}`].join('; ')
			}
		});
		expect(response.status()).toBe(200);
		return [...(await response.text()).matchAll(/Last active ([^<]+)</g)].map((m) => m[1]);
	};
	const utc = await render('UTC');
	expect(utc.length).toBeGreaterThan(0);
	for (const zone of ['%E0%A4%A', 'Mars%2FOlympus']) {
		// Overlap, not equality: a parallel spec can add or refresh a session row.
		const shown = await render(zone);
		expect(shown.filter((time) => utc.includes(time)).length).toBeGreaterThan(0);
	}
});
