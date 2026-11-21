import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu } from './library';

// Entries a connected app suggested wait under Suggestions in the universe's
// settings. The writer accepts one, which adds it to the universe, and
// dismisses another. The suggestions are seeded straight into the database,
// as an app would leave them through the endpoint.
test('a writer accepts one suggested entry and dismisses another', async ({ page }) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	const name = `Suggest ${stamp}`;
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(name);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await expect(page).toHaveURL(`/universes/suggest-${stamp}`);

	// Nothing waits yet.
	await page.getByRole('link', { name: 'Suggestions', exact: true }).click();
	await expect(page).toHaveURL(/\/suggestions$/);
	await expect(page.getByText('No suggested entries are waiting.')).toBeVisible();
	await expect(page.getByText('No proposed splits are waiting.')).toBeVisible();

	let universeId: string;
	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	try {
		const universe = await pool.query<{ id: string; owner_id: string }>(
			'select id, owner_id from universes where name = $1',
			[name]
		);
		universeId = universe.rows[0].id;
		for (const [kind, entry, description, seenIn] of [
			[
				'character',
				'Old Marit',
				'The lamplighter on the quay.\nShe keeps the harbour light.',
				'The Quay: "She lit the lantern."'
			],
			['place', 'Saltmere', null, null]
		]) {
			await pool.query(
				`insert into entity_proposals
				 (owner_id, universe_id, kind, name, description_md, seen_in, from_name)
				 values ($1, $2, $3, $4, $5, $6, 'E2E Desk (localhost)')`,
				[universe.rows[0].owner_id, universeId, kind, entry, description, seenIn]
			);
		}
	} finally {
		await pool.end();
	}

	// The link an app hands the writer names the universe by its id.
	await gotoReady(page, `/universes/${universeId}/suggestions`);
	await expect(page.getByRole('link', { name: 'Suggestions (2)' })).toBeVisible();
	const marit = page.locator('.list-row', { hasText: 'Old Marit' });
	await expect(marit).toContainText('Character. Suggested by E2E Desk (localhost).');
	await expect(marit).toContainText('The lamplighter on the quay.');
	// A description in several lines keeps them.
	await expect(marit.getByText('She keeps the harbour light.')).toHaveCSS(
		'white-space',
		'pre-line'
	);
	await expect(marit).toContainText('Seen in: The Quay');

	await marit.getByRole('button', { name: 'Accept Old Marit' }).click();
	await expect(page.getByRole('status')).toContainText('Added to this universe.');
	await expect(page.locator('.list-row', { hasText: 'Old Marit' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Suggestions (1)' })).toBeVisible();

	await page.getByRole('button', { name: 'Dismiss Saltmere' }).click();
	await expect(page.getByRole('status')).toContainText('Dismissed.');
	await expect(page.getByText('No suggested entries are waiting.')).toBeVisible();

	// The accepted entry is in Plan with its description; the dismissed one is not.
	await gotoReady(page, `/universes/suggest-${stamp}/plan`);
	await expect(page.locator('.ent-row', { hasText: 'Old Marit' })).toBeVisible();
	await expect(page.locator('.ent-row', { hasText: 'Saltmere' })).toHaveCount(0);
});
