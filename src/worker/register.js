// Registers the worker's module resolution hook (see loader.js), then the
// worker entry runs with `$lib` and extensionless imports resolvable. Loaded
// via `node --import ./src/worker/register.js src/worker/index.ts`.
import { register } from 'node:module';

register('./loader.js', import.meta.url);
