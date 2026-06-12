import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The worker runs Node directly on the TypeScript sources, and Node's ESM
// resolver requires explicit file extensions. A relative import without one
// works under Vite (the app) but crashes the worker at startup, taking every
// background job with it. This walks the worker's import graph and fails on
// any extensionless relative import, so the mistake cannot ship again.

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, 'index.ts');

function offenders(): string[] {
	const seen = new Set<string>();
	const bad: string[] = [];
	const walk = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		const src = fs.readFileSync(file, 'utf8');
		for (const match of src.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
			const spec = match[1];
			let target = path.resolve(path.dirname(file), spec);
			if (!spec.endsWith('.ts') && !spec.endsWith('.js')) {
				if (fs.existsSync(`${target}.ts`)) {
					bad.push(`${path.relative(process.cwd(), file)} -> ${spec}`);
					target = `${target}.ts`;
				} else if (fs.existsSync(path.join(target, 'index.ts'))) {
					bad.push(`${path.relative(process.cwd(), file)} -> ${spec}`);
					target = path.join(target, 'index.ts');
				} else {
					continue;
				}
			}
			if (fs.existsSync(target)) walk(target);
		}
	};
	walk(entry);
	return bad;
}

describe('worker import graph', () => {
	it('uses explicit extensions on every relative import', () => {
		expect(offenders()).toEqual([]);
	});
});
