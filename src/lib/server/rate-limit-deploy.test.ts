import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The shipped compose files trust X-Forwarded-For for the client address, which
// the per-IP rate limits key on. That is only safe when nothing but the proxy
// can reach the app, so the app port must be published on loopback by default:
// a port open on every interface lets a client send its own header straight to
// the app and pick a fresh address per request.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function appPorts(file: string): string[] {
	const text = fs.readFileSync(path.join(root, file), 'utf8');
	const block = text.match(/^ {2}app:\n((?: {4,}.*\n|\n)*)/m);
	if (!block) throw new Error(`${file} has no app service`);
	const ports = block[1].match(/^ {4}ports:\n((?: {6}- .*\n)+)/m);
	if (!ports) return [];
	return ports[1]
		.split('\n')
		.filter(Boolean)
		.map((line) => line.replace(/^ {6}- */, '').replace(/^'|'$/g, ''));
}

describe('app port binding', () => {
	for (const file of ['compose.yaml', 'README.md']) {
		it(`${file} publishes the app on loopback by default`, () => {
			const ports = appPorts(file);
			expect(ports.length, `${file} publishes no app port`).toBeGreaterThan(0);
			for (const port of ports) {
				expect(port).toMatch(/^\$\{APP_BIND:-127\.0\.0\.1\}:/);
			}
		});
	}
});
