import { createHash } from 'node:crypto';

// A short, stable id for this checkout.
//
// Several agents working in several worktrees at once would otherwise share a
// test database, a preview port, and the background worker's pid file, and none
// of those collisions announce themselves: a run silently reuses another's
// preview server and tests the wrong branch, or empties a database another run
// is midway through using.
//
// Derived from the path rather than the branch, so it stays the same across
// reruns in one worktree (databases are reused, not accumulated) and differs
// between worktrees. Every test process starts at the repository root, so cwd
// identifies the checkout.
export function checkoutId(): string {
	return createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8);
}

// A port of its own for this checkout's preview server, so a run never attaches
// to another checkout's. Override with E2E_PORT.
export function checkoutPort(): number {
	if (process.env.E2E_PORT) return Number(process.env.E2E_PORT);
	return 4173 + (parseInt(checkoutId(), 16) % 200);
}
