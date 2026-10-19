import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the design-system rules in scratch/system-design/design-system.md:
// no `var(--token, #hex)` fallbacks and no hard-coded white. Colours live in
// tokens.css; everything else reads a token.
const root = join(process.cwd(), 'src');
const exempt = new Set(['lib/styles/tokens.css']);

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sources(path);
		return /\.(css|svelte)$/.test(entry.name) ? [path] : [];
	});
}

function offences(pattern: RegExp): string[] {
	return sources(root).flatMap((file) => {
		const rel = relative(root, file);
		if (exempt.has(rel)) return [];
		return readFileSync(file, 'utf8')
			.split('\n')
			.flatMap((line, i) => (pattern.test(line) ? [`${rel}:${i + 1}: ${line.trim()}`] : []));
	});
}

describe('design tokens', () => {
	it('has no var() fallbacks to a hex colour', () => {
		expect(offences(/var\(--[^,)]+,\s*#/)).toEqual([]);
	});

	it('has no hard-coded white outside tokens.css', () => {
		expect(offences(/#fff(fff)?\b/i)).toEqual([]);
	});
});
