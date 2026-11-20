import { expect, test } from '@playwright/test';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { e2eDatabaseUrl } from './database';
import { gotoReady } from './navigate';
import { pickFromLibraryMenu, startStoryInUniverse } from './library';

// A background review started before a reload still shows afterwards: the card
// in the corner comes back, and the story's pages say it is running under the
// mode strip. The top bar lists it too (#1271), with a way to stop it. The job is queued straight into pg-boss to start an hour from
// now, so the worker leaves it queued for the length of the test.
test('a queued Assistant review shows again after a reload', async ({ page }) => {
	await gotoReady(page, '/');
	const stamp = Date.now();
	await pickFromLibraryMenu(page, 'New universe');
	await page.getByLabel('New universe').fill(`Tidewatch ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await gotoReady(page, '/');
	await startStoryInUniverse(page, `Tidewatch ${stamp}`);
	await page.getByLabel('New story').fill(`Runs ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/runs-${stamp}`);

	const pool = new pg.Pool({ connectionString: e2eDatabaseUrl() });
	const boss = new PgBoss({
		connectionString: e2eDatabaseUrl(),
		supervise: false,
		schedule: false
	});
	await boss.start();
	let jobId: string | null = null;
	try {
		const { rows } = await pool.query<{ id: string; owner_id: string }>(
			'select id, owner_id from stories where slug = $1',
			[`runs-${stamp}`]
		);
		const [story] = rows;
		jobId = await boss.send(
			'assistant-review',
			{ userId: story.owner_id, storyId: story.id, categories: [] },
			{ startAfter: 3600 }
		);

		await page.reload();
		await expect(page.locator('.activity-card')).toContainText(`Reviewing "Runs ${stamp}"...`);
		const note = page.locator('.run-note');
		await expect(note).toHaveText('Assistant review starting');
		await expect(note.getByRole('link')).toHaveAttribute('href', `/stories/${story.id}/review`);

		// Dismissing the card leaves the line, and it follows to the other modes.
		await page.locator('.activity-card').getByRole('button', { name: 'Dismiss' }).click();
		await page.getByRole('link', { name: 'Plan', exact: true }).click();
		await expect(page).toHaveURL(`/stories/runs-${stamp}/plan`);
		await expect(page.locator('.run-note')).toHaveText('Assistant review starting');

		// With its card dismissed, the job is still in the top bar's list.
		const work = page.getByRole('button', { name: 'Background work, 1 running' });
		await work.click();
		const panel = page.getByRole('dialog', { name: 'Background work' });
		await expect(panel).toContainText(`Reviewing "Runs ${stamp}"`);
		await expect(panel).toContainText('Started just now');
		// Escape closes it and hands focus back to its button.
		await page.keyboard.press('Escape');
		await expect(panel).toHaveCount(0);
		await expect(work).toBeFocused();

		// Stop ends the job; with nothing running the button goes too.
		await work.click();
		await panel.getByRole('button', { name: 'Stop' }).click();
		await expect(page.getByRole('button', { name: /Background work/ })).toHaveCount(0, {
			timeout: 15_000
		});
		await expect(page.locator('.run-note')).toHaveCount(0);
	} finally {
		if (jobId) await boss.deleteJob('assistant-review', jobId);
		await boss.stop({ graceful: false });
		await pool.end();
	}
});
