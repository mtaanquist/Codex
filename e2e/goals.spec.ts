import { expect, test } from '@playwright/test';

// Writing goals: an account daily word goal and a per-story target and
// deadline, both persisting across a reload.
test('set a daily word goal and a per-story target and deadline', async ({ page }) => {
	// Account-level daily word goal. Settings auto-save: a text field saves when
	// it loses focus.
	await page.goto('/account/editor');
	const goal = page.getByLabel('Daily word goal');
	await goal.fill('500');
	await goal.blur();
	await expect(page.getByText('Saved.')).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Daily word goal')).toHaveValue('500');

	// A story to set a target and deadline on.
	const stamp = Date.now();
	await page.goto('/');
	await page.getByRole('button', { name: 'New universe' }).click();
	await page.getByLabel('New universe').fill(`Goalfall ${stamp}`);
	await page.getByRole('button', { name: 'Create universe' }).click();
	await page.goto('/');
	await page
		.locator('.universe-section', { hasText: `Goalfall ${stamp}` })
		.getByRole('button', { name: 'New story in this universe' })
		.click();
	await page.getByLabel('New story').fill(`Targets ${stamp}`);
	await page.getByRole('button', { name: 'Create story' }).click();
	await expect(page).toHaveURL(`/stories/targets-${stamp}`);

	await page.goto(`/stories/targets-${stamp}/settings/goals`);
	const target = page.getByLabel('Target words (optional)');
	await target.fill('50000');
	await target.blur();
	await expect(page.getByText('Saved.')).toBeVisible();
	const deadline = page.getByLabel('Deadline (optional)');
	await deadline.fill('2027-01-01');
	await deadline.blur();
	await expect(page.getByText('Saved.')).toBeVisible();
	await page.reload();
	await expect(page.getByLabel('Target words (optional)')).toHaveValue('50000');
	await expect(page.getByLabel('Deadline (optional)')).toHaveValue('2027-01-01');
});
