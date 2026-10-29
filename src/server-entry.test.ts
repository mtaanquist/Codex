import { describe, it, expect } from 'vitest';
import { HOST_HEADER, PROTOCOL_HEADER, originParts, setOriginHeaders } from '../server.js';

describe('server entry origin', () => {
	it('splits ORIGIN into the protocol and host adapter-node reads', () => {
		expect(originParts('http://localhost:3000')).toEqual({
			protocol: 'http',
			host: 'localhost:3000'
		});
		expect(originParts('https://codex.example/')).toEqual({
			protocol: 'https',
			host: 'codex.example'
		});
	});

	it('refuses a missing or unusable ORIGIN', () => {
		expect(() => originParts(undefined)).toThrow(/ORIGIN is not set/);
		expect(() => originParts('')).toThrow(/ORIGIN is not set/);
		expect(() => originParts('codex.example')).toThrow();
		expect(() => originParts('ftp://codex.example')).toThrow(/http/);
	});

	it('overwrites origin headers a client sent', () => {
		const headers: Record<string, string> = {
			[PROTOCOL_HEADER]: 'https',
			[HOST_HEADER]: 'evil.example',
			host: 'evil.example'
		};
		setOriginHeaders(headers, originParts('http://localhost:3000'));
		expect(headers[PROTOCOL_HEADER]).toBe('http');
		expect(headers[HOST_HEADER]).toBe('localhost:3000');
	});
});
