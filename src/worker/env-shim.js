// Worker stand-in for SvelteKit's `$app/env/private`, which the app server
// generates from src/env.ts but the plain-Node worker does not have. It reads
// the same variables from the runtime environment, with an empty value counted
// as unset as src/env.ts does. The resolve hook (loader.js) maps the import here.
export const DATABASE_URL = process.env.DATABASE_URL || undefined;
export const ORIGIN = process.env.ORIGIN || undefined;
