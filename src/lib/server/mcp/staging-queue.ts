// One app's staging calls for one universe run one at a time, and the ones
// that wait do so here, in memory, before they take a database connection.
// Waiting on a lock inside the database would pin a pooled connection for
// each waiting call, and a burst from one app would leave none for anyone
// else. The app runs as one process (rate-limit.ts relies on the same), so a
// module-level map is enough; the advisory lock the caller takes inside its
// transaction still orders calls if that ever stops being true.

type Line = { tail: Promise<void>; size: number };

const lines = new Map<string, Line>();

export class StagingBusyError extends Error {
	constructor() {
		super('Another call is still running. Try again');
	}
}

// Runs `work` after every earlier call with the same key has finished. Throws
// StagingBusyError, without waiting, when `maxWaiting` calls are already in
// line behind the one that is running.
export async function inStagingTurn<T>(
	key: string,
	maxWaiting: number,
	work: () => Promise<T>
): Promise<T> {
	const line = lines.get(key) ?? { tail: Promise.resolve(), size: 0 };
	if (line.size > maxWaiting) throw new StagingBusyError();
	lines.set(key, line);
	line.size += 1;
	const before = line.tail;
	let finished!: () => void;
	line.tail = new Promise<void>((resolve) => (finished = resolve));
	try {
		await before;
		return await work();
	} finally {
		finished();
		line.size -= 1;
		if (line.size === 0) lines.delete(key);
	}
}
