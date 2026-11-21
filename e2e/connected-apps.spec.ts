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

test('a writer connects an app, disconnects it, then makes and revokes a token', async ({
	page,
	request
}) => {
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

	// A faulty request is shown here with a link back. The browser is not
	// sent on to the app's address by itself.
	await gotoReady(page, authorize.replace('response_type=code', 'response_type=token'));
	await expect(
		page.getByRole('heading', { name: 'This request cannot be answered' })
	).toBeVisible();
	await expect(page).toHaveURL(/\/oauth\/authorize\?/);
	await expect(page.getByRole('link', { name: 'Return to localhost' })).toHaveAttribute(
		'href',
		/^http:\/\/localhost:9\/callback\?error=unsupported_response_type/
	);
	await gotoReady(page, authorize);

	// Access is off until the writer turns it on, and there is nothing to allow.
	await expect(page.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0);
	await page.getByRole('link', { name: 'Open Connected apps' }).click();
	await expect(page.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Help: connecting an app' })).toHaveAttribute(
		'href',
		'/docs/connecting-apps'
	);
	await waitForHydration(page);
	// Turning access on asks for the password; a wrong one leaves it off.
	const accessForm = page.locator('form[action="?/setExternalAccess"]');
	// The refusal shows in the form, in view, on a phone as on a desk, and
	// what was typed is kept.
	const desk = page.viewportSize()!;
	for (const size of [{ width: 390, height: 700 }, desk]) {
		await page.setViewportSize(size);
		await accessForm.getByLabel('Confirm your password').fill('not-the-password');
		await accessForm.getByRole('button', { name: 'Turn on access for apps' }).click();
		const refusal = accessForm.getByText('That password is not right.');
		await expect(refusal).toBeVisible();
		await expect(refusal).toBeInViewport({ ratio: 1 });
		await expect(page.getByText('That password is not right.')).toHaveCount(1);
		await expect(accessForm.getByLabel('Confirm your password')).toHaveValue('not-the-password');
		await page.reload();
		await waitForHydration(page);
	}
	await expect(page.getByLabel('Address to give the app')).toHaveCount(0);
	await accessForm.getByLabel('Confirm your password').fill('e2e-password');
	await accessForm.getByRole('button', { name: 'Turn on access for apps' }).click();
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

	// The app uses the address with its token.
	const mcp = (body: unknown, headers: Record<string, string>) =>
		request.post('/api/mcp', {
			data: body,
			headers: { accept: 'application/json, text/event-stream', ...headers }
		});
	const callTool = {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: { name: 'list_universes', arguments: {} }
	};
	const bearer = { authorization: `Bearer ${tokens.access_token}` };
	const called = await mcp(callTool, bearer);
	expect(called.status()).toBe(200);
	expect(await called.text()).toContain('universes');

	// Without the token the endpoint says where to sign in, and the signed-in
	// browser's own session does not count.
	const anonymous = await mcp(callTool, {});
	expect(anonymous.status()).toBe(401);
	expect(anonymous.headers()['www-authenticate']).toContain(
		'/.well-known/oauth-protected-resource/api/mcp'
	);
	const withSession = await page.request.post('/api/mcp', { data: callTool });
	expect(withSession.status()).toBe(401);

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
	expect((await mcp(callTool, bearer)).status()).toBe(401);

	// A personal access token, for a tool that cannot open the consent page.
	// A wrong password makes none.
	await gotoReady(page, '/account/apps');
	const tokenForm = page.locator('form[action="?/createToken"]');
	await tokenForm.getByLabel('Token name').fill('E2E Script');
	await tokenForm.getByLabel('Confirm your password').fill('not-the-password');
	await tokenForm.getByRole('button', { name: 'Create token' }).click();
	// The refusal shows where the writer is looking, and the name is kept.
	await expect(tokenForm.getByText('That password is not right.')).toBeInViewport();
	await expect(page.getByLabel('Your new token')).toHaveCount(0);
	await expect(tokenForm.getByLabel('Token name')).toHaveValue('E2E Script');

	await tokenForm.getByLabel('Confirm your password').fill('e2e-password');
	await tokenForm.getByRole('button', { name: 'Create token' }).click();
	// The token is shown once, so the page brings it into view.
	await expect(page.getByLabel('Your new token')).toBeInViewport({ ratio: 1 });
	await expect(page.getByLabel('Your new token')).toBeFocused();
	await expect(tokenForm.getByLabel('Token name')).toHaveValue('');
	const personal = await page.getByLabel('Your new token').inputValue();
	expect(personal).toMatch(/^cdx_pat_/);
	const personalBearer = { authorization: `Bearer ${personal}` };
	expect((await mcp(callTool, personalBearer)).status()).toBe(200);

	// It is listed by name, and the token itself is not shown again.
	await gotoReady(page, '/account/apps');
	await expect(page.getByLabel('Your new token')).toHaveCount(0);
	const tokenRow = page.locator('.list-row', { hasText: 'E2E Script' });
	await expect(tokenRow).toContainText('May: read your writing, leave suggestions and comments.');
	await expect(tokenRow).toContainText('Expires');
	await expect(tokenRow).toContainText('Last used');
	await tokenRow.getByRole('button', { name: 'Revoke the token E2E Script' }).click();
	await expect(tokenRow).toHaveCount(0);
	expect((await mcp(callTool, personalBearer)).status()).toBe(401);
});

test('a form post from another site is still refused everywhere else', async ({ request }) => {
	for (const headers of [{}, { origin: 'https://elsewhere.example' }]) {
		const response = await request.post('/login', { form: { email: 'a@example.com' }, headers });
		expect(response.status()).toBe(403);
	}
});
