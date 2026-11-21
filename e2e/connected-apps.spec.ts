import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { gotoReady, waitForHydration } from './navigate';

// Connecting an outside app: the app sends a signed-out writer to the consent
// page, the writer signs in and comes back to it, turns access on, allows the
// app, and can see and disconnect it afterwards. Runs on its own account and
// starts signed out.
test.use({ storageState: { cookies: [], origins: [] } });

const VERIFIER = 'e2e-verifier-'.padEnd(64, 'x');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
// An app on this computer: registered without a port, used with one.
const CALLBACK = 'http://localhost:9/callback';

test('a writer connects an app, sees it listed and disconnects it', async ({ page, request }) => {
	const registered = await request.post('/oauth/register', {
		data: { client_name: 'E2E Desk', redirect_uris: ['http://localhost/callback'] }
	});
	expect(registered.status()).toBe(201);
	const { client_id: clientId } = await registered.json();

	const authorize =
		'/oauth/authorize?' +
		new URLSearchParams({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: CALLBACK,
			code_challenge: CHALLENGE,
			code_challenge_method: 'S256',
			state: 'e2e-state',
			scope: 'read suggest'
		});

	// Signed out, the consent page sends the writer to sign in and back.
	await gotoReady(page, authorize);
	await expect(page).toHaveURL(/\/login/);
	await page.getByLabel('Email').fill('apps-e2e@example.com');
	await page.getByLabel('Password').fill('e2e-password');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await expect(page).toHaveURL(/\/oauth\/authorize\?/);
	await expect(page.getByRole('heading', { name: 'Connect an app' })).toBeVisible();
	await expect(page.getByText('E2E Desk (localhost) wants to connect')).toBeVisible();

	// Access is off until the writer turns it on, and there is nothing to allow.
	await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0);
	await page.getByRole('link', { name: 'Open Connected apps' }).click();
	await expect(page.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
	await waitForHydration(page);
	// The checkbox is a hidden input behind the switch, so click the switch.
	await page
		.locator('label.toggle', { has: page.getByLabel('Allow other apps to connect') })
		.click();
	await expect(page.getByLabel('Address to give the app')).toHaveValue(/\/api\/mcp$/);
	await expect(page.getByText('No app is connected. Paste the address above')).toBeVisible();

	// Back at the consent page: allow reading only.
	await gotoReady(page, authorize);
	await expect(page.getByLabel('Read your writing')).toBeDisabled();
	await page.getByLabel('Leave suggestions and comments').uncheck();
	await page.route(`${CALLBACK}**`, (route) =>
		route.fulfill({ contentType: 'text/html', body: '<p>Back in the app</p>' })
	);
	await page.getByRole('button', { name: 'Allow', exact: true }).click();
	await page.waitForURL(`${CALLBACK}**`);
	const answer = new URL(page.url());
	expect(answer.searchParams.get('state')).toBe('e2e-state');
	const code = answer.searchParams.get('code')!;
	expect(code).toBeTruthy();

	// The app trades the code for tokens with a form post that carries no
	// Origin header, as a program outside the browser does.
	const token = await request.post('/oauth/token', {
		form: {
			grant_type: 'authorization_code',
			code,
			client_id: clientId,
			redirect_uri: CALLBACK,
			code_verifier: VERIFIER
		}
	});
	expect(token.status()).toBe(200);
	const tokens = await token.json();
	expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'read' });

	await gotoReady(page, '/account/apps');
	const row = page.locator('.list-row', { hasText: 'E2E Desk (localhost)' });
	await expect(row).toContainText('May: read your writing.');
	await row.getByRole('button', { name: 'Disconnect E2E Desk (localhost)' }).click();
	await expect(row).toHaveCount(0);

	const refreshed = await request.post('/oauth/token', {
		form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }
	});
	expect(refreshed.status()).toBe(400);
	expect((await refreshed.json()).error).toBe('invalid_grant');
});

test('a form post from another site is still refused everywhere else', async ({ request }) => {
	for (const headers of [{}, { origin: 'https://elsewhere.example' }]) {
		const response = await request.post('/login', { form: { email: 'a@example.com' }, headers });
		expect(response.status()).toBe(403);
	}
});
