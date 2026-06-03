import { readFileSync, rmSync } from 'node:fs';
import { WORKER_PID_FILE } from './global-setup';

export default function globalTeardown() {
	try {
		const pid = Number(readFileSync(WORKER_PID_FILE, 'utf8'));
		if (pid > 0) process.kill(pid);
		rmSync(WORKER_PID_FILE);
	} catch {
		// Worker already gone; nothing to clean up.
	}
}
