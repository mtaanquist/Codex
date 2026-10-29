// Registers the worker's module resolution hook (see loader.js), then the
// worker entry runs with extensionless and `#lib` imports resolvable. Loaded
// via `node --import ./src/worker/register.js src/worker/index.ts`.
import { registerHooks } from 'node:module';
import { resolve } from './loader.js';

registerHooks({ resolve });
