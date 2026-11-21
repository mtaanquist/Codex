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

// parse makes the form from a stored value, field by field: a field that is
// missing or not the type expected (the length box bound while empty, a value
// from an older version of the app) takes its default, so one odd field never
// costs the writer the brief they typed. It returns undefined only for a
// value that is no form at all, which is then dropped.
export function readDraftForm<T>(
	kind: Kind,
	id: string,
	parse: (value: unknown) => T | undefined
): T | undefined {
	const key = `${PREFIX}${kind}.${id}`;
	let value: unknown;
	if (memory.has(key)) value = memory.get(key);
	else {
		try {
			const raw = store()?.getItem(key);
			if (!raw) return undefined;
			value = JSON.parse(raw);
		} catch {
			value = null;
		}
	}
	const form = parse(value);
	if (form === undefined) dropDraftForm(kind, id);
	return form;
}

// A stored value as a plain object, for a parse function to read fields off.
export function storedFields(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

// A stored length in words: null when the box was empty or the value is not
// a number, for the caller's default to stand in.
export function storedWords(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
