import { type Page } from '@playwright/test';

// Server-rendered markup is clickable before Svelte attaches its handlers, so a
// click landing in that window does nothing and the panel it should have opened
// never appears. Playwright cannot see the difference: the button is visible,
// enabled and stable either way. Under parallel load the window is wide enough
// to lose races in, which is where the suite's intermittent failures came from.
//
// The root layout sets data-hydrated on the document once the client has taken
// over (see src/routes/+layout.svelte). Wait for it whenever a test interacts
// straight after a navigation.

export async function waitForHydration(page: Page) {
	await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached' });
}

// goto, then wait for the page to be interactive. Returns what page.goto does,
// so callers can still assert on the response status.
export async function gotoReady(page: Page, url: string) {
	const response = await page.goto(url);
	await waitForHydration(page);
	return response;
}
