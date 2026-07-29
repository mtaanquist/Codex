import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { E2E_DATABASE_URL } from './e2e/database';

// The preview server, the seeded worker, and global setup all read process.env
// directly, so .env has to reach this process for a local run to match CI.
// Variables already set in the shell are left alone, which is how CI supplies
// its own and how DATABASE_URL can be pointed elsewhere for a single run.
if (existsSync('.env')) process.loadEnvFile('.env');

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
		// a value so the 2FA journey works without extra setup. The database is
		// the suite's own, not the one in .env (see e2e/database.ts).
		env: {
			...(process.env as Record<string, string>),
			DATABASE_URL: E2E_DATABASE_URL,
			APP_SECRET: process.env.APP_SECRET ?? 'e2e-app-secret'
		}
	}
});
