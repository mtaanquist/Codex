import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		// Matches the compose.dev.yaml database; real deployments set DATABASE_URL.
		url: process.env.DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex'
	},
	verbose: true,
	strict: true
});
