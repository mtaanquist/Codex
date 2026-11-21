import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
	isClientIdUrl,
	isLoopbackRedirect,
	parseClientMetadata,
	redirectHost,
	redirectMatches,
	validCodeChallenge,
	validRedirectUri,
	verifyPkce
} from './rules';

const HOSTED = 'https://app.example/api/mcp/auth_callback';

describe('validRedirectUri', () => {
	it('accepts https anywhere and plain http only on this computer', () => {
		for (const uri of [
			HOSTED,
			'http://localhost/callback',
			'http://localhost:3118/callback',
			'http://127.0.0.1:9000/cb',
			'http://[::1]:9000/cb'
		]) {
			expect(validRedirectUri(uri)).toBe(true);
		}
	});

	it('refuses everything else', () => {
		for (const uri of [
			'http://app.example/callback',
			'http://localhost.evil.example/callback',
			'http://127.0.0.1.evil.example/callback',
			'javascript:alert(1)',
			'data:text/html,hi',
			'myapp://callback',
			'https://app.example/callback#fragment',
			'https://user:pass@app.example/callback',
			'/relative',
			'',
			'https://app.example/' + 'a'.repeat(3000),
			null,
			42
		]) {
			expect(validRedirectUri(uri)).toBe(false);
		}
	});
});

describe('redirectMatches', () => {
	it('needs an exact match for an https address', () => {
		expect(redirectMatches([HOSTED], HOSTED)).toBe(true);
		for (const requested of [
			HOSTED + '/',
			HOSTED + '?x=1',
			'https://app.example:444/api/mcp/auth_callback',
			'https://app.example.evil.example/api/mcp/auth_callback',
			'https://APP.example/api/mcp/auth_callback/..'
		]) {
			expect(redirectMatches([HOSTED], requested)).toBe(false);
		}
	});

	it('ignores the port for a local app, and nothing else', () => {
		const registered = ['http://localhost/callback', 'http://127.0.0.1/callback'];
		expect(redirectMatches(registered, 'http://localhost:3118/callback')).toBe(true);
		expect(redirectMatches(registered, 'http://127.0.0.1:51234/callback')).toBe(true);
		expect(redirectMatches(registered, 'http://localhost:3118/other')).toBe(false);
		expect(redirectMatches(registered, 'http://localhost:3118/callback?x=1')).toBe(false);
		expect(redirectMatches(registered, 'http://[::1]:3118/callback')).toBe(false);
		expect(redirectMatches(registered, 'https://localhost:3118/callback')).toBe(false);
	});

	it('never matches a local address against an https registration', () => {
		expect(redirectMatches([HOSTED], 'http://localhost:1/api/mcp/auth_callback')).toBe(false);
	});

	it('refuses an address that is not acceptable at all, even if registered', () => {
		expect(redirectMatches(['javascript:alert(1)'], 'javascript:alert(1)')).toBe(false);
	});
});

describe('redirectHost', () => {
	it('names the host, without the port for a local app', () => {
		expect(redirectHost(HOSTED)).toBe('app.example');
		expect(redirectHost('https://app.example:8443/cb')).toBe('app.example:8443');
		expect(redirectHost('http://localhost:3118/callback')).toBe('localhost');
		expect(isLoopbackRedirect('http://localhost:3118/callback')).toBe(true);
		expect(isLoopbackRedirect(HOSTED)).toBe(false);
	});
});

describe('PKCE', () => {
	const verifier = 'a'.repeat(43);
	const challenge = createHash('sha256').update(verifier).digest('base64url');

	it('accepts the verifier the challenge was made from', () => {
		expect(validCodeChallenge(challenge)).toBe(true);
		expect(verifyPkce(verifier, challenge)).toBe(true);
	});

	it('refuses another verifier, a short one and a missing one', () => {
		expect(verifyPkce('b'.repeat(43), challenge)).toBe(false);
		expect(verifyPkce('a'.repeat(42), challenge)).toBe(false);
		expect(verifyPkce('a'.repeat(129), challenge)).toBe(false);
		expect(verifyPkce(undefined, challenge)).toBe(false);
		// The plain method (challenge equal to the verifier) is not supported.
		expect(verifyPkce(verifier, verifier)).toBe(false);
	});

	it('refuses a challenge of the wrong shape', () => {
		for (const value of ['', 'short', challenge + 'x', challenge.slice(0, 42) + '=', null]) {
			expect(validCodeChallenge(value)).toBe(false);
		}
	});
});

describe('isClientIdUrl', () => {
	it('accepts an https address with a path', () => {
		expect(isClientIdUrl('https://app.example/oauth/client-metadata.json')).toBe(true);
	});

	it('refuses anything else', () => {
		for (const value of [
			'https://app.example',
			'https://app.example/',
			'http://app.example/client.json',
			'https://app.example/client.json#x',
			'https://user@app.example/client.json',
			'6f1c2f0e-5c1e-4d55-9a53-0a6f3f0b7c11',
			''
		]) {
			expect(isClientIdUrl(value)).toBe(false);
		}
	});
});

describe('parseClientMetadata', () => {
	it('takes the name and the redirect addresses', () => {
		expect(
			parseClientMetadata({
				client_name: '  Writing Desk ',
				redirect_uris: [HOSTED, HOSTED, `${HOSTED}/second`],
				token_endpoint_auth_method: 'none',
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code']
			})
		).toEqual({
			ok: true,
			metadata: {
				clientName: 'Writing Desk',
				redirectUris: [HOSTED, `${HOSTED}/second`]
			}
		});
	});

	it('refuses redirect addresses on more than one remote host', () => {
		const other = new URL(HOSTED);
		other.hostname = 'evil.example';
		for (const redirect_uris of [
			// The first host would be shown while the code went to the second.
			[HOSTED, other.toString()],
			[other.toString(), HOSTED],
			// Local addresses beside them do not make two remote hosts one.
			['http://127.0.0.1/callback', HOSTED, other.toString()],
			// Another port is another host.
			[HOSTED, HOSTED.replace(new URL(HOSTED).host, `${new URL(HOSTED).host}:8443`)]
		]) {
			expect(parseClientMetadata({ redirect_uris })).toMatchObject({
				ok: false,
				error: 'invalid_redirect_uri'
			});
		}
		// Local addresses are one class, whatever name this computer goes by.
		expect(
			parseClientMetadata({
				redirect_uris: ['http://localhost/callback', 'http://127.0.0.1:9/cb', 'http://[::1]/cb']
			})
		).toMatchObject({ ok: true });
		// A desktop app may list its local address beside one remote host.
		for (const redirect_uris of [
			[HOSTED, 'http://localhost/callback'],
			['http://127.0.0.1/callback', 'http://[::1]:7/cb', HOSTED]
		]) {
			expect(parseClientMetadata({ redirect_uris })).toMatchObject({ ok: true });
		}
	});

	it('leaves the name empty when there is none and strips control characters', () => {
		const unnamed = parseClientMetadata({ redirect_uris: [HOSTED] });
		expect(unnamed.ok && unnamed.metadata.clientName).toBeNull();
		const odd = parseClientMetadata({ client_name: 'A\nB\u0000C', redirect_uris: [HOSTED] });
		expect(odd.ok && odd.metadata.clientName).toBe('A B C');
		// Characters that reorder or hide text are taken out as well.
		const hidden = parseClientMetadata({
			client_name: 'Claude\u202Eia.edualc\u200B\u2066',
			redirect_uris: [HOSTED]
		});
		expect(hidden.ok && hidden.metadata.clientName).toBe('Claudeia.edualc');
		const long = parseClientMetadata({ client_name: 'x'.repeat(500), redirect_uris: [HOSTED] });
		expect(long.ok && long.metadata.clientName?.length).toBe(120);
	});

	it('refuses a missing, empty, oversized or unacceptable redirect list', () => {
		for (const redirect_uris of [
			undefined,
			[],
			'https://app.example/cb',
			[HOSTED, 'http://app.example/cb'],
			[HOSTED, 'myapp://cb'],
			Array.from({ length: 11 }, (_, i) => `https://app.example/cb${i}`)
		]) {
			expect(parseClientMetadata({ redirect_uris })).toMatchObject({
				ok: false,
				error: 'invalid_redirect_uri'
			});
		}
	});

	it('refuses a client that wants a secret or another flow', () => {
		for (const extra of [
			{ token_endpoint_auth_method: 'client_secret_post' },
			{ grant_types: ['client_credentials'] },
			{ response_types: ['token'] }
		]) {
			expect(parseClientMetadata({ redirect_uris: [HOSTED], ...extra })).toMatchObject({
				ok: false,
				error: 'invalid_client_metadata'
			});
		}
	});

	it('refuses anything that is not an object', () => {
		for (const input of [null, 'x', [], 3]) {
			expect(parseClientMetadata(input)).toMatchObject({ ok: false });
		}
	});
});
