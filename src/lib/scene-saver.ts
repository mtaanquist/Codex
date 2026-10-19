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
};

export function createSceneSaver(
	sceneId: string,
	initialBodyMd: string,
	onConflict: (conflict: SceneConflict | null) => void
): SceneSaver {
	let base = textHash(initialBodyMd);
	// The fingerprint of a save still on its way. The close-tab save can race
	// it, so that one is accepted against either text.
	let inFlight: string | null = null;
	let overwrite = false;

	return {
		async save({ keepalive, title, bodyMd, markers }) {
			const hash = textHash(bodyMd);
			const baseHashes = inFlight ? [base, inFlight] : [base];
			const sendOverwrite = overwrite;
			if (!keepalive) inFlight = hash;
			let response: Response;
			try {
				response = await fetch(`/api/scenes/${sceneId}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					keepalive,
					body: JSON.stringify({
						title,
						bodyMd,
						markers,
						baseHashes,
						overwrite: sendOverwrite || undefined
					})
				});
			} finally {
				if (!keepalive) inFlight = null;
			}
			if (response.status === 409) {
				const conflict = (await response.json()) as SceneConflict;
				onConflict({ bodyMd: conflict.bodyMd, title: conflict.title });
				throw new Error('the scene changed somewhere else');
			}
			if (!response.ok) throw new Error(`save failed: ${response.status}`);
			if (!keepalive) {
				base = hash;
				overwrite = false;
			}
		},
		adopt(bodyMd) {
			base = textHash(bodyMd);
			overwrite = false;
			onConflict(null);
		},
		keepMine(serverBodyMd) {
			base = textHash(serverBodyMd);
			overwrite = true;
			onConflict(null);
		}
	};
}
