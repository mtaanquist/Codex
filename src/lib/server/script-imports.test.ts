import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// The npm scripts (backup, restore:backup, migrate, seed:admin) run under
// plain node, which resolves `#lib/*` without trying extensions, unlike Vite
// and the worker's loader. Load what they import the same way.
const MODULES = [
	'src/lib/server/backups.ts',
	'src/lib/server/db/migrate.ts',
	'src/lib/server/db/schema.ts',
	'src/lib/server/admin.ts'
];

describe('script imports', () => {
	it.each(MODULES)('%s loads under plain node', (path) => {
		const run = () =>
			execFileSync(process.execPath, ['--input-type=module', '-e', `await import('./${path}')`], {
				stdio: 'pipe'
			});
		expect(run).not.toThrow();
	});
});
