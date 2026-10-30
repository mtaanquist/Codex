import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The npm scripts (backup, restore:backup, migrate, seed:admin) run under
// plain node, which resolves `#lib/*` without trying extensions, unlike Vite
// and the worker's loader. Load every app module they import the same way.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MODULES = [
	...new Set(
		readdirSync(`${ROOT}scripts`)
			.filter((name) => name.endsWith('.ts'))
			.flatMap((name) =>
				[
					...readFileSync(`${ROOT}scripts/${name}`, 'utf8').matchAll(/from '\.\.\/(src\/[^']+)'/g)
				].map((match) => match[1])
			)
	)
];

describe('script imports', () => {
	it('finds the app modules the scripts import', () => {
		expect(MODULES).toContain('src/lib/server/backups.ts');
	});

	it.each(MODULES)('%s loads under plain node', (path) => {
		const run = () =>
			execFileSync(process.execPath, ['--input-type=module', '-e', `await import('./${path}')`], {
				cwd: ROOT,
				stdio: 'pipe'
			});
		expect(run).not.toThrow();
	});
});
