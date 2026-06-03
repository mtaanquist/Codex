import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		// Unit tests live next to the code; integration tests (against a real
		// throwaway Postgres) live under tests/integration. End-to-end tests run
		// under Playwright (see playwright.config.ts) and are excluded here.
		include: ['src/**/*.{test,spec}.ts', 'tests/integration/**/*.{test,spec}.ts'],
		environment: 'node'
	}
});
