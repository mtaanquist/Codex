import { textHash } from './text-hash';

// Which texts the server may hold for something this page saves, as
// fingerprints: the last text a save was answered for, and the texts of saves
// whose outcome is unknown (still on their way, or lost to a network error
// after the server may have applied them). A save sends the whole list, and
// the server takes it when the stored text is any of them. The scene editors
// and the scene draft card both save this way.

// Fingerprints a save may send: the base plus the most recent unsettled
// attempts. Enough that a run of timed-out saves does not push out one the
// server applied late, which would show the writer's own words as a conflict.
export const MAX_BASE_HASHES = 16;
const MAX_PENDING = MAX_BASE_HASHES - 1;

export type SaveBases = {
	// The fingerprints to send with a save or a decision made now.
	current: () => string[];
	// A save of this text is going out. Returns its fingerprint and the list
	// to send with it; the text counts as one the server may hold from here on.
	begin: (text: string) => { hash: string; baseHashes: string[] };
	// The server answered that save, whatever the answer: its outcome is known.
	answered: (hash: string) => void;
	// The server holds that save's text now.
	landed: (hash: string) => void;
	// The page shows this server text (loaded after a conflict, or changed
	// there by the page's own hand): the next save builds on it alone.
	reset: (text: string) => void;
	// Whether hash is a text this page saved or may have saved.
	knows: (hash: string) => boolean;
	// Whether a save's outcome is still unknown.
	unsettled: () => boolean;
};

export function createSaveBases(initialText: string): SaveBases {
	let base = textHash(initialText);
	let pending: string[] = [];
	return {
		current: () => [base, ...pending],
		begin(text) {
			const hash = textHash(text);
			const baseHashes = [base, ...pending];
			// A retry of the same text must not push older unsettled hashes out.
			pending = [...pending.filter((h) => h !== hash), hash].slice(-MAX_PENDING);
			return { hash, baseHashes };
		},
		answered(hash) {
			pending = pending.filter((h) => h !== hash);
		},
		landed(hash) {
			base = hash;
		},
		reset(text) {
			base = textHash(text);
			pending = [];
		},
		knows: (hash) => hash === base || pending.includes(hash),
		unsettled: () => pending.length > 0
	};
}
