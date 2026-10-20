import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The global sheets all load on every page, so a class given its own rule in
// two places is decided by load order and an edit to one copy appears not to
// apply. A selector may still appear in a grouped rule (`.a, .b { ... }`)
// next to its own rule; only two standalone rules for it are flagged.
const dir = join(process.cwd(), 'src/lib/styles');

function standaloneSelectors(css: string): string[] {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const found: string[] = [];
	let depth = 0;
	let buf = '';
	for (const ch of text) {
		if (ch === '{') {
			const prelude = buf.trim().replace(/\s+/g, ' ');
			if (depth === 0 && !prelude.startsWith('@') && !prelude.includes(',')) found.push(prelude);
			depth++;
			buf = '';
		} else if (ch === '}') {
			depth--;
			buf = '';
		} else if (ch === ';') buf = '';
		else buf += ch;
	}
	return found;
}

describe('global sheets', () => {
	it('flags a selector given two standalone rules', () => {
		const css = '.a { color: red; }\n.b, .a { margin: 0; }\n.a { padding: 0; }';
		expect(standaloneSelectors(css)).toEqual(['.a', '.a']);
	});

	it('defines each standalone selector once', () => {
		const seen = new Map<string, string[]>();
		for (const file of readdirSync(dir).filter((name) => name.endsWith('.css'))) {
			for (const selector of standaloneSelectors(readFileSync(join(dir, file), 'utf8'))) {
				seen.set(selector, [...(seen.get(selector) ?? []), file]);
			}
		}
		const twice = [...seen].filter(([, files]) => files.length > 1).map(([s, f]) => `${s}: ${f}`);
		expect(twice).toEqual([]);
	});
});
