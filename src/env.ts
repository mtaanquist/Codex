import { defineEnvVars } from '@sveltejs/kit/env';

// Read when the app starts, so one image serves any install. An empty value
// counts as unset. The worker reads the same names through its own shim
// (src/worker/env-shim.js); keep the two lists in step.
export const variables = defineEnvVars({
	DATABASE_URL: {
		schema: (value) => value || undefined,
		description: 'Postgres connection string.'
	},
	ORIGIN: {
		schema: (value) => value || undefined,
		description: 'The public URL the app is reached on, such as https://codex.example.'
	}
});
