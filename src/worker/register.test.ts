import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from './loader.js';

// Runs Node the way the worker starts, with deprecations as errors, so a hook
// API that Node deprecates (module.register on Node 26) fails here instead of
// as a warning in the worker log.
function runWithHooks(code: string): string {
	return execFileSync(
		process.execPath,
		[
			'--throw-deprecation',
			'--import',
			'./src/worker/register.js',
			'--input-type=module',
			'-e',
			code
		],
		{ encoding: 'utf8' }
	).trim();
}

describe('worker resolve hook', () => {
	it('resolves #lib, the private env shim and extensionless relative imports', () => {
		const out = runWithHooks(`
			const lib = await import('#lib/server/origin-rule');
			const env = await import('$app/env/private');
			const rel = await import('./src/lib/server/origin-rule');
			console.log(typeof lib.resolveOrigin, 'DATABASE_URL' in env, rel.resolveOrigin === lib.resolveOrigin);
		`);
		expect(out).toBe('function true true');
	});

	it('resolves #lib modules named with a dot, such as x.svelte.ts', () => {
		const out = runWithHooks(`console.log(import.meta.resolve('#lib/focus-mode.svelte'));`);
		expect(out).toMatch(/src\/lib\/focus-mode\.svelte\.ts$/);
	});

	it('leaves a package its own #lib imports', () => {
		const next = (specifier: string) => ({ url: `next:${specifier}` });
		const fromPackage = { parentURL: 'file:///app/node_modules/pkg/index.js' };
		expect(resolve('#lib/util', fromPackage, next).url).toBe('next:#lib/util');
		const fromApp = { parentURL: import.meta.url };
		expect(resolve('#lib/server/origin-rule', fromApp, next).url).toMatch(
			/src\/lib\/server\/origin-rule\.ts$/
		);
	});
});
