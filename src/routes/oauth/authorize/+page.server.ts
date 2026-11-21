import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { logEvent } from '#lib/server/log';
import { publicOrigin } from '#lib/server/origin';
import { formText } from '#lib/server/validation';
import { BASE_PERMISSION, PERMISSION_TEXT } from '#lib/mcp-access';
import {
	AUTHORIZE_FIELDS,
	checkAuthorizeRequest,
	chosenPermissions,
	clientRedirect
} from '#lib/server/mcp/authorize';
import { createAuthorizationCode, existingGrant } from '#lib/server/mcp/oauth';
import { isLoopbackRedirect, redirectHost } from '#lib/server/mcp/rules';
import { mcpAccountEnabled, mcpInstanceEnabled } from '#lib/server/mcp/settings';

// The consent page: an outside app sends the writer here to ask for access.
// The hook guarantees a signed-in writer (see return-to.ts for the trip
// through sign-in). Nothing is granted until the writer presses Allow, and the
// answer goes back to the app's registered address only.

export const load: PageServerLoad = async ({ url, locals, setHeaders }) => {
	if (!(await mcpInstanceEnabled(db))) error(404, 'Not found');
	setHeaders({ 'cache-control': 'no-store' });
	const check = await checkAuthorizeRequest(
		db,
		(name) => url.searchParams.get(name),
		publicOrigin(url)
	);
	if (check.kind === 'invalid') return { status: 'invalid' as const, message: check.message };
	// A faulty request is shown, with a link to the app's own address. It is
	// not followed for the visitor (see AuthorizeCheck).
	if (check.kind === 'refused') {
		return { status: 'refused' as const, host: check.host, returnTo: check.location };
	}

	const user = locals.user!;
	const { client } = check;
	const connected = await existingGrant(db, user.id, client.id);
	return {
		status: 'ok' as const,
		accessOn: await mcpAccountEnabled(db, user.id),
		email: user.email,
		// A client that registered itself is named by the host the answer goes
		// to, read from the address in use and not from the registration. One
		// named by a metadata document keeps the document's host.
		client: {
			clientName: client.clientName,
			host: client.kind === 'dcr' ? redirectHost(check.redirectUri) : client.host
		},
		// Shown when the answer goes somewhere other than the app's own host.
		redirectHost: redirectHost(check.redirectUri),
		local: isLoopbackRedirect(check.redirectUri),
		connected: connected !== null,
		permissions: check.offered.map((id) => ({
			id,
			...PERMISSION_TEXT[id],
			required: id === BASE_PERMISSION,
			// An app the writer already connected starts from what it has.
			checked: (connected?.permissions ?? check.requested).includes(id)
		})),
		fields: AUTHORIZE_FIELDS.map((name) => ({ name, value: url.searchParams.get(name) })).filter(
			(entry): entry is { name: (typeof AUTHORIZE_FIELDS)[number]; value: string } =>
				entry.value !== null
		)
	};
};

async function recheck(data: FormData, url: URL) {
	if (!(await mcpInstanceEnabled(db))) error(404, 'Not found');
	return checkAuthorizeRequest(
		db,
		(name) => (data.has(name) ? formText(data, name) : null),
		publicOrigin(url)
	);
}

const FAULTY =
	'The request from the app is not one Codex can answer. Nothing was shared with it. Go back to the app and try connecting again.';

// Both actions answer with the address to go to next rather than a redirect:
// the page's own policy only lets its forms submit to this site, and some
// browsers apply that to a redirect that follows a form.
export const actions: Actions = {
	allow: async ({ request, url, locals }) => {
		const data = await request.formData();
		const check = await recheck(data, url);
		if (check.kind === 'invalid') return fail(400, { message: check.message });
		if (check.kind === 'refused') return fail(400, { message: FAULTY });
		const user = locals.user!;
		if (!(await mcpAccountEnabled(db, user.id))) {
			return fail(403, {
				message: 'Access for other apps is turned off for your account. Turn it on first.'
			});
		}
		const permissions = chosenPermissions(check.offered, data.getAll('permission').map(String));
		const code = await createAuthorizationCode(db, {
			userId: user.id,
			client: check.client,
			permissions,
			redirectUri: check.redirectUri,
			codeChallenge: check.codeChallenge,
			sessionId: locals.session!.id
		});
		if (!code) {
			return fail(403, {
				message:
					'Your sign-in has ended, or access for other apps was turned off. Nothing was shared. Sign in again, then go back to the app and try connecting again.'
			});
		}
		logEvent('info', 'oauth.allowed', {
			userId: user.id,
			clientId: check.client.clientId,
			host: check.client.host,
			permissions
		});
		return {
			continueTo: clientRedirect(check.redirectUri, publicOrigin(url), {
				code,
				state: check.state
			})
		};
	},
	deny: async ({ request, url, locals }) => {
		const data = await request.formData();
		const check = await recheck(data, url);
		if (check.kind === 'invalid') return fail(400, { message: check.message });
		if (check.kind === 'refused') return fail(400, { message: FAULTY });
		logEvent('info', 'oauth.denied', {
			userId: locals.user!.id,
			clientId: check.client.clientId
		});
		return {
			continueTo: clientRedirect(check.redirectUri, publicOrigin(url), {
				error: 'access_denied',
				error_description: 'The writer did not allow access.',
				state: check.state
			})
		};
	}
};
