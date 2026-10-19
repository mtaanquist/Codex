import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	classifyAddress,
	decideEgress,
	egressHttpRequest,
	EgressDeniedError,
	EgressTimeoutError,
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
		// NAT64 well-known prefix (64:ff9b::/96) carries the v4 target.
		['64:ff9b::a9fe:a9fe', 'link-local'],
		['64:ff9b::10.0.0.1', 'private'],
		['64:ff9b::7f00:1', 'loopback'],
		['64:ff9b::808:808', 'public'],
		// Local-use NAT64 (64:ff9b:1::/48): the v4 position varies, so blocked.
		['64:ff9b:1::a9fe:a9fe', 'private'],
		['64:ff9b:1:ffff::808:808', 'private'],
		// 6to4 (2002::/16) carries the v4 in bytes 2-5.
		['2002:a9fe:a9fe::1', 'link-local'],
		['2002:c0a8:101::', 'private'],
		['2002:808:808::1', 'public'],
		// IPv4-compatible (::a.b.c.d, deprecated) and IPv4-translated (::ffff:0:a.b.c.d).
		['::169.254.169.254', 'link-local'],
		['::10.1.2.3', 'private'],
		['::8.8.8.8', 'public'],
		['::ffff:0:a9fe:a9fe', 'link-local'],
		// Other reserved ranges are not unicast targets.
		['2001::a9fe:a9fe', 'invalid'], // Teredo 2001::/32
		['2001:db8::1', 'invalid'], // documentation
		['100::1', 'invalid'], // discard-only 100::/64
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

	it('refuses a NAT64 literal that embeds the metadata address', async () => {
		const http = egressHttpRequest({ policy: 'block-private', allowlist: [] });
		await expect(
			http('http://[64:ff9b::a9fe:a9fe]/v1/models', { method: 'GET', headers: {} })
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

	it('drops an endpoint that accepts the connection and never answers', async () => {
		const server = createServer(() => {});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const http = egressHttpRequest({ policy: 'open', allowlist: [] }, 100);
			await expect(
				http(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: {} })
			).rejects.toBeInstanceOf(EgressTimeoutError);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it('drops a response body that stalls part way', async () => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.write('data: {}\n\n');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		try {
			const http = egressHttpRequest({ policy: 'open', allowlist: [] }, 100);
			const response = await http(`http://127.0.0.1:${port}/`, { method: 'GET', headers: {} });
			await expect(response.text()).rejects.toBeInstanceOf(EgressTimeoutError);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});
});
