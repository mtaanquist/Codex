import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { Database } from '../auth';
import { appSettings } from '../db/schema';
import { readSetting } from '../settings';
import type { HttpRequest, HttpRequestInit, HttpResponse } from './providers/types';

// The SSRF guard. Because the writer's key is held server-side, the app server
// (not the browser) makes the outbound completion call to whatever endpoint the
// writer configured. On a shared hosted instance that is a request-forgery
// vector into internal infrastructure, so every outbound call passes through
// here, after DNS resolution, with rebinding protection: validation runs in the
// connect-time lookup, so a name that re-resolves to a private address between
// check and connect is still refused.

export type EgressPolicyName = 'block-private' | 'allowlist' | 'open';

export type EgressPolicy = {
	policy: EgressPolicyName;
	allowlist: string[];
};

const EGRESS_KEY = 'llm-egress';

// Safe-for-hosted by default: refuse private, loopback, link-local, and
// unique-local addresses.
const DEFAULT_POLICY: EgressPolicy = { policy: 'block-private', allowlist: [] };

export class EgressDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EgressDeniedError';
	}
}

export type AddressClass =
	| 'public'
	| 'loopback'
	| 'private'
	| 'link-local'
	| 'unique-local'
	| 'invalid';

function classifyV4(ip: string): AddressClass {
	const octets = ip.split('.').map((d) => Number(d));
	if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return 'invalid';
	}
	const [a, b] = octets;
	if (a === 0) return 'loopback'; // 0.0.0.0/8 "this host"
	if (a === 127) return 'loopback'; // 127.0.0.0/8
	if (a === 10) return 'private'; // 10.0.0.0/8
	if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
	if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
	if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64.0.0/10 (CGNAT)
	if (a === 169 && b === 254) return 'link-local'; // 169.254.0.0/16
	if (a >= 224) return 'invalid'; // multicast/reserved/broadcast - not a unicast target
	return 'public';
}

// Expand an IPv6 string (already validated by isIP) to its 16 bytes, resolving
// '::' compression and any embedded IPv4 tail.
function expandV6(ip: string): number[] | null {
	let s = ip;
	const zone = s.indexOf('%');
	if (zone !== -1) s = s.slice(0, zone);
	// An embedded dotted-quad tail (::ffff:127.0.0.1) becomes two hextets.
	const lastColon = s.lastIndexOf(':');
	const tail = s.slice(lastColon + 1);
	if (tail.includes('.')) {
		const v4 = tail.split('.').map((d) => Number(d));
		if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
		const hex = `${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
		s = s.slice(0, lastColon + 1) + hex;
	}
	const halves = s.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [];
	const rear = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const missing = 8 - (head.length + rear.length);
	if (halves.length === 1 && head.length !== 8) return null;
	if (halves.length === 2 && missing < 0) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rear];
	if (groups.length !== 8) return null;
	const bytes: number[] = [];
	for (const g of groups) {
		const v = parseInt(g || '0', 16);
		if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
		bytes.push((v >> 8) & 0xff, v & 0xff);
	}
	return bytes;
}

function classifyV6(ip: string): AddressClass {
	const b = expandV6(ip);
	if (!b) return 'invalid';
	// IPv4-mapped (::ffff:0:0/96): classify the embedded v4 so ::ffff:127.0.0.1
	// is loopback, not a public v6 address.
	if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
		return classifyV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
	}
	if (b.every((x) => x === 0)) return 'loopback'; // :: unspecified
	if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return 'loopback'; // ::1
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local'; // fe80::/10
	if ((b[0] & 0xfe) === 0xfc) return 'unique-local'; // fc00::/7
	if (b[0] === 0xff) return 'invalid'; // multicast - not a unicast target
	return 'public';
}

export function classifyAddress(ip: string): AddressClass {
	const kind = isIP(ip);
	if (kind === 4) return classifyV4(ip);
	if (kind === 6) return classifyV6(ip);
	return 'invalid';
}

export type EgressDecision = { allowed: true } | { allowed: false; reason: string };

// The policy decision for a host and its resolved addresses. The request path
// re-runs this at connect time (via the lookup) to defeat rebinding; exposing
// it pure makes the decisions testable without a network.
export function decideEgress(
	host: string,
	addresses: string[],
	policy: EgressPolicy
): EgressDecision {
	if (policy.policy === 'open') return { allowed: true };
	if (policy.policy === 'allowlist') {
		return policy.allowlist.includes(normaliseHost(host))
			? { allowed: true }
			: { allowed: false, reason: `Host ${host} is not on the allowed list.` };
	}
	// block-private: every resolved address must be public.
	if (addresses.length === 0) return { allowed: false, reason: `Could not resolve ${host}.` };
	for (const address of addresses) {
		const cls = classifyAddress(address);
		if (cls !== 'public') {
			return { allowed: false, reason: `Blocked egress to a ${cls} address (${address}).` };
		}
	}
	return { allowed: true };
}

function normaliseHost(host: string): string {
	return host.replace(/^\[|\]$/g, '').toLowerCase();
}

export async function egressPolicy(db: Database): Promise<EgressPolicy> {
	const stored = await readSetting<Partial<EgressPolicy>>(db, EGRESS_KEY);
	if (!stored) return DEFAULT_POLICY;
	const policy: EgressPolicyName =
		stored.policy === 'allowlist' || stored.policy === 'open' ? stored.policy : 'block-private';
	const allowlist = Array.isArray(stored.allowlist)
		? stored.allowlist.filter((h): h is string => typeof h === 'string')
		: [];
	return { policy, allowlist };
}

export type SaveEgressResult = { ok: true } | { ok: false; reason: string };

export async function saveEgressPolicy(
	db: Database,
	input: EgressPolicy
): Promise<SaveEgressResult> {
	if (input.policy !== 'block-private' && input.policy !== 'allowlist' && input.policy !== 'open') {
		return { ok: false, reason: 'Unknown egress policy.' };
	}
	const allowlist = Array.from(
		new Set(input.allowlist.map((h) => normaliseHost(h.trim())).filter((h) => h.length > 0))
	);
	if (input.policy === 'allowlist' && allowlist.length === 0) {
		return { ok: false, reason: 'Add at least one allowed host, or choose another policy.' };
	}
	await db
		.insert(appSettings)
		.values({ key: EGRESS_KEY, value: { policy: input.policy, allowlist } })
		.onConflictDoUpdate({
			target: appSettings.key,
			set: { value: { policy: input.policy, allowlist }, updatedAt: new Date() }
		});
	return { ok: true };
}

// A DNS lookup that validates every resolved address against the policy before
// the socket connects. Node calls this for hostnames; IP-literal hosts skip the
// lookup entirely, so doRequest checks those up front.
function guardedLookup(host: string, policy: EgressPolicy) {
	return (
		hostname: string,
		options: LookupOptions,
		callback: (
			err: NodeJS.ErrnoException | null,
			address: string | LookupAddress[],
			family?: number
		) => void
	): void => {
		dnsLookup(
			hostname,
			{ family: options?.family, hints: options?.hints, all: true },
			(err, addrs) => {
				if (err) return callback(err, '', 0);
				const list = addrs as LookupAddress[];
				const decision = decideEgress(
					host,
					list.map((a) => a.address),
					policy
				);
				if (!decision.allowed) return callback(new EgressDeniedError(decision.reason), '', 0);
				if (options?.all) return callback(null, list);
				callback(null, list[0].address, list[0].family);
			}
		);
	};
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

function doRequest(
	url: string,
	init: HttpRequestInit,
	policy: EgressPolicy
): Promise<HttpResponse> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return Promise.reject(new EgressDeniedError('The endpoint URL is not valid.'));
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return Promise.reject(new EgressDeniedError('Only http and https endpoints are allowed.'));
	}
	const host = normaliseHost(parsed.hostname);

	if (policy.policy === 'allowlist' && !policy.allowlist.includes(host)) {
		return Promise.reject(
			new EgressDeniedError(`Host ${parsed.hostname} is not on the allowed list.`)
		);
	}
	// An IP-literal host bypasses the lookup, so validate it directly here.
	if (policy.policy === 'block-private' && isIP(host)) {
		const decision = decideEgress(host, [host], policy);
		if (!decision.allowed) return Promise.reject(new EgressDeniedError(decision.reason));
	}
	const useLookup =
		policy.policy === 'block-private' && !isIP(host) ? guardedLookup(host, policy) : undefined;
	const send = parsed.protocol === 'https:' ? httpsRequest : httpRequest;

	return new Promise<HttpResponse>((resolve, reject) => {
		const req = send(
			url,
			{
				method: init.method,
				headers: init.headers,
				signal: init.signal,
				...(useLookup ? { lookup: useLookup } : {})
			},
			(res: IncomingMessage) => {
				const headers: Record<string, string> = {};
				for (const [k, v] of Object.entries(res.headers)) {
					if (typeof v === 'string') headers[k] = v;
					else if (Array.isArray(v)) headers[k] = v.join(', ');
				}
				const body = res as unknown as AsyncIterable<Uint8Array>;
				resolve({
					status: res.statusCode ?? 0,
					headers,
					body,
					text: () => collect(body)
				});
			}
		);
		req.on('error', reject);
		if (init.body) req.write(init.body);
		req.end();
	});
}

// The egress-guarded transport the gateway hands to a provider. Bound to one
// resolved policy; every call it makes is validated.
export function egressHttpRequest(policy: EgressPolicy): HttpRequest {
	return (url, init) => doRequest(url, init, policy);
}
