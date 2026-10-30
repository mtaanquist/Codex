import { keepaliveFits, saveFailure, UnretryableSaveError } from './autosave';
import { textHash } from './text-hash';

// The scene editors' save request, with the conflict check. Each save sends
// the fingerprint of the text this editor last saw on the server; when the
// scene changed somewhere else in the meantime (another tab or device, an
// accepted suggestion), the server refuses and returns its version, and
// onConflict hands it to the editor to offer a choice.

export type SceneConflict = { bodyMd: string; title: string | null };

export type SceneSaver = {
	save: (opts: {
		keepalive: boolean;
		title: string | null;
		bodyMd: string;
		markers?: { id: string; anchorStart: number; anchorEnd: number }[];
	}) => Promise<void>;
	// The editor now shows this server text (loaded after a conflict, or synced
	// in from outside), so the next save builds on it.
	adopt: (bodyMd: string) => void;
	// Keep the editor's text over the newer server version on the next save.
	keepMine: (serverBodyMd: string) => void;
	// The server's text changed by this editor's own hand (an accepted
	// suggestion applied to fromHash), and the editor applied the same change
	// locally. Ignored when fromHash is not a text this editor saved, so a
	// change from another window still reports as a conflict.
	rebase: (bodyMd: string, fromHash: string) => void;
};

// A save that gets no answer in this time counts as a network error, so the
// autosave retries it and a page waiting on it is not held indefinitely. A
// long scene gets longer, so a slow link can still send it (about 1 KB/s),
// up to two minutes so a stalled network does not hold a scene switch long.
export const SAVE_TIMEOUT_MS = 30_000;
const SAVE_TIMEOUT_MAX_MS = 120_000;
export function saveTimeoutMs(body: string): number {
	return Math.min(SAVE_TIMEOUT_MS + body.length, SAVE_TIMEOUT_MAX_MS);
}

// Fingerprints a save may send: the base plus the most recent unsettled
// attempts. Enough that a run of timed-out saves does not push out one the
// server applied late, which would show the writer's own words as a conflict.
export const MAX_BASE_HASHES = 16;
const MAX_PENDING = MAX_BASE_HASHES - 1;

export function createSceneSaver(
	sceneId: string,
	initialBodyMd: string,
	onConflict: (conflict: SceneConflict | null) => void
): SceneSaver {
	let base = textHash(initialBodyMd);
	// Fingerprints of saves whose outcome is unknown: still on their way, or
	// lost to a network error after the server may have applied them.
	let pending: string[] = [];
	let overwrite = false;
	// Bumped whenever the editor settles a conflict or rebases, so a refusal
	// for an older save does not bring the notice back.
	let generation = 0;

	function settle(hash: string) {
		pending = pending.filter((h) => h !== hash);
	}

	return {
		async save({ keepalive, title, bodyMd, markers }) {
			const hash = textHash(bodyMd);
			const baseHashes = [base, ...pending];
			const sendOverwrite = overwrite;
			const started = generation;
			// A retry of the same text must not push older unsettled hashes out.
			pending = [...pending.filter((h) => h !== hash), hash].slice(-MAX_PENDING);
			// A network error leaves the hash pending: the server may have saved it.
			const body = JSON.stringify({
				title,
				bodyMd,
				markers,
				baseHashes,
				overwrite: sendOverwrite || undefined
			});
			const controller = new AbortController();
			// Covers reading a refusal's body too.
			const timer = setTimeout(() => controller.abort(), saveTimeoutMs(body));
			try {
				const response = await fetch(`/api/scenes/${sceneId}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					keepalive: keepalive && keepaliveFits(body),
					body,
					// The close-tab save outlives the page; nothing waits on it.
					signal: keepalive ? undefined : controller.signal
				});
				settle(hash);
				if (response.status === 409) {
					const conflict = (await response.json()) as SceneConflict;
					if (started === generation)
						onConflict({ bodyMd: conflict.bodyMd, title: conflict.title });
					throw new UnretryableSaveError('the scene changed somewhere else');
				}
				if (!response.ok) throw saveFailure(response.status);
			} finally {
				clearTimeout(timer);
			}
			if (started === generation) {
				base = hash;
				overwrite = false;
			}
		},
		adopt(bodyMd) {
			generation++;
			base = textHash(bodyMd);
			pending = [];
			overwrite = false;
			onConflict(null);
		},
		keepMine(serverBodyMd) {
			generation++;
			base = textHash(serverBodyMd);
			pending = [];
			overwrite = true;
			onConflict(null);
		},
		rebase(bodyMd, fromHash) {
			if (fromHash !== base && !pending.includes(fromHash)) return;
			generation++;
			base = textHash(bodyMd);
			pending = [];
			// A refusal caused by the accept itself is settled too.
			onConflict(null);
		}
	};
}
