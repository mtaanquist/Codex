import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// Runs as the account with the Assistant switched on.
test.use({ storageState: 'e2e/.auth/assistant.json' });

// #1170: "Suggest details with the Assistant" counts what it would read first.
// A large read is confirmed before it runs, and the whole book is offered when
// it fits. The endpoint is stubbed, so no model is needed.
// A story with one character in the universe; returns their ids.
async function storyWithCharacter(page: Page) {
	await gotoReady(page, '/');
	const name = `Suggest ${Date.now()}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} - settings`);
	await gotoReady(page, '/');
	await startStoryInUniverse(page, name);
	await page.getByLabel('New story').fill('Tides');
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page.locator('.story-title')).toHaveText('Tides');

	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	let storyId: string;
	let characterId: string;
	try {
		const { rows } = await pool.query<{ story_id: string; universe_id: string; owner_id: string }>(
			`select st.id as story_id, u.id as universe_id, u.owner_id from stories st
			 join universes u on u.id = st.universe_id where u.name = $1`,
			[name]
		);
		storyId = rows[0].story_id;
		const character = await pool.query<{ id: string }>(
			`insert into characters (universe_id, owner_id, name) values ($1, $2, 'Bram') returning id`,
			[rows[0].universe_id, rows[0].owner_id]
		);
		characterId = character.rows[0].id;
	} finally {
		await pool.end();
	}
	return { storyId, characterId };
}

test('a large read is confirmed first, and the whole book can be read after', async ({ page }) => {
	const { storyId, characterId } = await storyWithCharacter(page);

	const modes: unknown[] = [];
	await page.route('**/api/assistant/enrich', async (route) => {
		const body = route.request().postDataJSON() as { estimate?: boolean; mode?: string };
		if (body.estimate) {
			await route.fulfill({
				json: {
					model: 'stub',
					scenes: { scenes: 12, requests: 2, estTokens: 31000, estCostUsd: 0.12 },
					book: { scenes: 40, requests: 1, estTokens: 98000 },
					confirm: true
				}
			});
			return;
		}
		modes.push(body.mode);
		await route.fulfill({
			json: {
				suggestions:
					body.mode === 'book'
						? [{ id: 'b1', field: 'alias', label: null, value: 'the harbourmaster' }]
						: [{ id: 's1', field: 'detail', label: 'Eyes', value: 'grey' }],
				scenes: 12,
				requests: 2
			}
		});
	});

	await gotoReady(page, `/stories/${storyId}/plan?entity=${characterId}`);
	const suggest = page.getByRole('button', { name: 'Suggest details with the Assistant' });
	await suggest.click();

	// The count is shown and nothing has been read yet.
	const ask = page.locator('.assist-ask');
	await expect(ask).toContainText('12 scenes, about 31,000 tokens (about $0.12)');
	await expect(ask).toContainText('read in 2 parts');
	expect(modes).toEqual([]);

	// Cancel reads nothing; asking again and confirming reads the scenes.
	await ask.getByRole('button', { name: 'Cancel' }).click();
	await expect(ask).toHaveCount(0);
	expect(modes).toEqual([]);
	await suggest.click();
	await ask.getByRole('button', { name: 'Read' }).click();
	const suggestions = page.locator('.assist-suggestions');
	await expect(suggestions).toContainText('grey');
	expect(modes).toEqual(['scenes']);

	// The whole book is offered, with its own count and no price to show.
	await page.getByRole('button', { name: 'Read the whole book' }).click();
	await expect(ask).toContainText('the whole book: 40 scenes, about 98,000 tokens.');
	await expect(ask).not.toContainText('$');
	await ask.getByRole('button', { name: 'Read' }).click();
	await expect(suggestions).toContainText('the harbourmaster');
	expect(modes).toEqual(['scenes', 'book']);
	await expect(page.getByRole('button', { name: 'Read the whole book' })).toHaveCount(0);
});

test('nothing is read when the count fails or the text is too long', async ({ page }) => {
	const { storyId, characterId } = await storyWithCharacter(page);
	let reads = 0;
	let estimate: 'fail' | 'tooLong' = 'fail';
	await page.route('**/api/assistant/enrich', async (route) => {
		const body = route.request().postDataJSON() as { estimate?: boolean };
		if (!body.estimate) {
			reads += 1;
			await route.fulfill({ json: { suggestions: [], scenes: 0, requests: 0 } });
		} else if (estimate === 'fail') {
			await route.fulfill({ status: 500, json: { message: 'Internal Error' } });
		} else {
			await route.fulfill({
				json: {
					model: 'stub',
					scenes: { scenes: 300, requests: 40, estTokens: 240000 },
					confirm: true,
					tooLong: true
				}
			});
		}
	});

	await gotoReady(page, `/stories/${storyId}/plan?entity=${characterId}`);
	const suggest = page.getByRole('button', { name: 'Suggest details with the Assistant' });
	const note = page.locator('.assist-enrich .assist-note');
	await suggest.click();
	await expect(note).not.toBeEmpty();
	await expect(suggest).toBeEnabled();
	expect(reads).toBe(0);

	estimate = 'tooLong';
	await suggest.click();
	await expect(note).toContainText('300 scenes, about 240,000 tokens, too long to read here');
	await expect(page.locator('.assist-ask')).toHaveCount(0);
	expect(reads).toBe(0);
});
