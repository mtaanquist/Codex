import { describe, it, expect } from 'vitest';
import {
	classifyAddress,
	decideEgress,
	egressHttpRequest,
	EgressDeniedError,
	type AddressClass,
	type EgressPolicy
} from './egress';

describe('classifyAddress', () => {
	const cases: [string, AddressClass][] = [
		['127.0.0.1', 'loopback'],
		['0.0.0.0', 'loopback'],
		['10.1.2.3', 'private'],
		['172.16.5.4', 'private'],
		['172.31.255.255', 'private'],
		['172.32.0.1', 'public'],
		['192.168.0.1', 'private'],
		['100.64.0.1', 'private'],
		['169.254.10.20', 'link-local'],
		['224.0.0.1', 'invalid'],
		['8.8.8.8', 'public'],
		['1.1.1.1', 'public'],
		['::1', 'loopback'],
		['::', 'loopback'],
		['fe80::1', 'link-local'],
		['fc00::1', 'unique-local'],
		['fd12:3456:789a::1', 'unique-local'],
		['ff02::1', 'invalid'],
		['2606:4700:4700::1111', 'public'],
		['::ffff:127.0.0.1', 'loopback'],
		['::ffff:8.8.8.8', 'public'],
		['not-an-ip', 'invalid'],
		['999.1.1.1', 'invalid']
	];
	for (const [ip, expected] of cases) {
		it(`${ip} -> ${expected}`, () => {
			expect(classifyAddress(ip)).toBe(expected);
		});
	}
});

describe('decideEgress', () => {
	const block: EgressPolicy = { policy: 'block-private', allowlist: [] };

	it('block-private allows a public address', () => {
		expect(decideEgress('api.example.com', ['8.8.8.8'], block).allowed).toBe(true);
	});

	it('block-private refuses when any resolved address is private (rebinding)', () => {
		expect(decideEgress('rebind.example.com', ['8.8.8.8', '10.0.0.5'], block).allowed).toBe(false);
	});

	it('block-private refuses a host that resolved to nothing', () => {
		expect(decideEgress('nowhere.example.com', [], block).allowed).toBe(false);
	});

	it('open allows anything, even loopback', () => {
		const open: EgressPolicy = { policy: 'open', allowlist: [] };
		expect(decideEgress('localhost', ['127.0.0.1'], open).allowed).toBe(true);
	});

	it('allowlist gates on host membership, not the address', () => {
		const policy: EgressPolicy = { policy: 'allowlist', allowlist: ['ollama.internal'] };
		expect(decideEgress('ollama.internal', ['10.0.0.9'], policy).allowed).toBe(true);
		expect(decideEgress('evil.example.com', ['8.8.8.8'], policy).allowed).toBe(false);
	});
});

describe('egressHttpRequest', () => {
	it('refuses a loopback IP-literal endpoint before connecting', async () => {
		const http = egressHttpRequest({ policy: 'block-private', allowlist: [] });
		await expect(
			http('http://127.0.0.1:9/v1/chat/completions', { method: 'POST', headers: {}, body: '{}' })
		).rejects.toBeInstanceOf(EgressDeniedError);
	});

	it('refuses a non-http scheme under any policy', async () => {
		const http = egressHttpRequest({ policy: 'open', allowlist: [] });
		await expect(http('file:///etc/passwd', { method: 'GET', headers: {} })).rejects.toBeInstanceOf(
			EgressDeniedError
		);
	});

	it('refuses localhost by name under block-private (rebinding guard at lookup)', async () => {
		const http = egressHttpRequest({ policy: 'block-private', allowlist: [] });
		await expect(
			http('http://localhost:9/v1/chat/completions', { method: 'POST', headers: {}, body: '{}' })
		).rejects.toBeInstanceOf(EgressDeniedError);
	});

	it('refuses a host that is not on the allowlist', async () => {
		const http = egressHttpRequest({ policy: 'allowlist', allowlist: ['ollama.internal'] });
		await expect(
			http('http://example.com/v1/chat/completions', { method: 'POST', headers: {}, body: '{}' })
		).rejects.toBeInstanceOf(EgressDeniedError);
	});
});
