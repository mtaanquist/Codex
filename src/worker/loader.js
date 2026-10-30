// Module resolution hook for the worker. The worker runs the app's TypeScript
// source directly under Node (no bundler), so two things Vite handles for the
// app need handling here: extensionless imports, both relative ones and
// `#lib/*` ones (Node maps `#lib` through package.json `imports` but does not
// add an extension). App modules use them freely; rather than make every
// module the worker might reach carry worker-specific import styles, this hook
// resolves them the way Vite would. Everything else (npm packages, node:
// builtins, already-extensioned paths) falls through to Node's default resolver.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `#lib` maps to src/lib (package.json `imports`); this loader sits in
// src/worker, so src/lib is ../lib.
const libBase = new URL('../lib/', import.meta.url);

const CANDIDATES = ['', '.ts', '.js', '/index.ts', '/index.js'];

// Resolve a base URL (possibly without an extension) to an existing file URL,
// trying the same candidates a bundler would. Returns null if none exist.
/** @param {URL} baseUrl @returns {string | null} */
function resolveFile(baseUrl) {
	const basePath = fileURLToPath(baseUrl);
	for (const suffix of CANDIDATES) {
		const candidate = basePath + suffix;
		if (suffix === '' && (!existsSync(candidate) || !statSync(candidate).isFile())) continue;
		if (suffix !== '' && !existsSync(candidate)) continue;
		return pathToFileURL(candidate).href;
	}
	return null;
}

// SvelteKit generates `$app/env/private` for the app server only; data
// helpers the worker reaches import it, so point it at the shim.
const envShim = new URL('./env-shim.js', import.meta.url).href;

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: object) => { url: string }} nextResolve
 */
export function resolve(specifier, context, nextResolve) {
	if (specifier === '$app/env/private') {
		return { url: envShim, shortCircuit: true };
	}
	// Every #lib specifier goes through the candidates, extension or not, so
	// `#lib/x.svelte` finds `x.svelte.ts` the way Vite does.
	if (specifier.startsWith('#lib/')) {
		const resolved = resolveFile(new URL(specifier.slice('#lib/'.length), libBase));
		if (resolved) return { url: resolved, shortCircuit: true };
	} else if (
		(specifier.startsWith('./') || specifier.startsWith('../')) &&
		context.parentURL &&
		!/\.[a-z0-9]+$/i.test(specifier)
	) {
		const resolved = resolveFile(new URL(specifier, context.parentURL));
		if (resolved) return { url: resolved, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
