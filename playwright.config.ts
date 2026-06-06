import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	globalSetup: './e2e/global-setup.ts',
	globalTeardown: './e2e/global-teardown.ts',
	// Sign-in hashes with argon2 by design, so a login under parallel load can
	// take a few seconds; give assertions room so a slow-but-correct response is
	// not read as a failure.
	expect: { timeout: 10_000 },
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
