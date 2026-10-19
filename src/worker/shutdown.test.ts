import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKER_STOP_TIMEOUT_MS } from './shutdown.ts';

// Docker sends SIGKILL once the stop grace period runs out (10s by default).
// The worker's own stop timeout has to end before that, with room to fail the
// running jobs into a retry and close the connection.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MARGIN_MS = 10_000;

function workerGraceMs(file: string): number | null {
	const text = fs.readFileSync(path.join(root, file), 'utf8');
	const block = text.match(/^ {2}worker:\n((?: {4,}.*\n|\n)*)/m);
	if (!block) throw new Error(`${file} has no worker service`);
	const grace = block[1].match(/^ {4}stop_grace_period: *'?(\d+)s'?\s*$/m);
	return grace ? Number(grace[1]) * 1000 : null;
}

describe('worker shutdown budget', () => {
	for (const file of ['compose.yaml', 'README.md']) {
		it(`${file} gives the worker longer to stop than its own timeout`, () => {
			const grace = workerGraceMs(file);
			expect(grace, `${file} sets no stop_grace_period on the worker`).not.toBeNull();
			expect(grace!).toBeGreaterThanOrEqual(WORKER_STOP_TIMEOUT_MS + MARGIN_MS);
		});
	}
});
