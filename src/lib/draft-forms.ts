// Brief forms for a scene or chapter draft that the writer has open, so one
// half typed is still there after the panel was closed, another scene was
// opened, or the page was reloaded. Kept in memory and in sessionStorage (this
// tab only, gone when it closes), and dropped when the draft is started, the
// form is cancelled, or the writer signs out.

const PREFIX = 'codex.draft-form.';
const memory = new Map<string, unknown>();

type Kind = 'scene' | 'chapter';

// Private browsing and a full or blocked store throw; the memory copy then
// carries the form for the page's life.
function store(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

export function readDraftForm<T>(kind: Kind, id: string): T | undefined {
	const key = `${PREFIX}${kind}.${id}`;
	if (memory.has(key)) return memory.get(key) as T;
	try {
		const raw = store()?.getItem(key);
		if (!raw) return undefined;
		const value = JSON.parse(raw) as T;
		memory.set(key, value);
		return value;
	} catch {
		return undefined;
	}
}

export function keepDraftForm(kind: Kind, id: string, value: unknown): void {
	const key = `${PREFIX}${kind}.${id}`;
	memory.set(key, value);
	try {
		store()?.setItem(key, JSON.stringify(value));
	} catch {
		// Kept in memory only.
	}
}

export function dropDraftForm(kind: Kind, id: string): void {
	const key = `${PREFIX}${kind}.${id}`;
	memory.delete(key);
	try {
		store()?.removeItem(key);
	} catch {
		// Nothing was stored.
	}
}

// For sign-out: the next person at this browser does not find these briefs.
export function dropAllDraftForms(): void {
	memory.clear();
	try {
		const held = store();
		if (!held) return;
		for (let i = held.length - 1; i >= 0; i--) {
			const key = held.key(i);
			if (key?.startsWith(PREFIX)) held.removeItem(key);
		}
	} catch {
		// Nothing was stored.
	}
}
