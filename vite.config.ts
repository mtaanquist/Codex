import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// Kit 3 drops $lib for #lib subpath imports; this keeps the old
			// specifier working until the codebase moves over.
			alias: { $lib: 'src/lib' },
			// Scripts only from this origin, plus the inline ones SvelteKit (and the
			// theme script in app.html) mark with a nonce. Styles are left open:
			// Svelte transitions insert inline style elements.
			csp: {
				mode: 'auto',
				directives: {
					'script-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'frame-ancestors': ['none'],
					'frame-src': ['none'],
					'form-action': ['self']
				}
			}
		})
	],
	test: {
		// Unit tests live next to the code; integration tests (against a real
		// throwaway Postgres) live under tests/integration. End-to-end tests run
		// under Playwright (see playwright.config.ts) and are excluded here.
		include: ['src/**/*.{test,spec}.ts', 'tests/integration/**/*.{test,spec}.ts'],
		environment: 'node',
		// Integration test files share one test database; running files in
		// parallel would let their truncates race.
		fileParallelism: false
	}
});
