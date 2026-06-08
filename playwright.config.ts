import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	globalSetup: './e2e/global-setup.ts',
	globalTeardown: './e2e/global-teardown.ts',
	// Sign-in hashes with argon2 by design, so a login under parallel load can
	// take a few seconds; give assertions room so a slow-but-correct response is
	// not read as a failure.
	expect: { timeout: 10_000 },
	// On CI the suite runs in parallel against one preview server, where a
	// browser journey can hit an irreducible timing hiccup; retry so a single
	// load flake does not red-flag an otherwise green run. Retried tests show as
	// "flaky" in the report, so a test that keeps retrying still gets noticed and
	// fixed. Locally there are no retries, so flakes surface while developing.
	retries: process.env.CI ? 2 : 0,
	use: { baseURL: 'http://localhost:4173' },
	// One login for the whole run: the setup project signs in as the e2e
	// user and saves the session; specs that need a signed-out browser (or
	// a different account) opt out with their own storageState.
	projects: [
		{ name: 'setup', testMatch: /auth\.setup\.ts/ },
		{
			name: 'main',
			dependencies: ['setup'],
			use: { storageState: 'e2e/.auth/e2e.json' }
		}
	],
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		reuseExistingServer: !process.env.CI,
		// Two-factor encrypts its secret with APP_SECRET; give the preview server
		// a value so the 2FA journey works without extra setup.
		env: {
			...(process.env as Record<string, string>),
			APP_SECRET: process.env.APP_SECRET ?? 'e2e-app-secret'
		}
	}
});
