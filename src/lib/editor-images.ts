import { EditorView } from '@codemirror/view';
import { StateEffect, StateField, type Extension } from '@codemirror/state';

// Paste or drop an image into the prose: it uploads and lands as a
// markdown image pointing at the app-served path. Markdown is the stored
// form, so exports carry the reference as plain text.
//
// The upload is async, so the insertion point is captured as a placeholder
// the moment the image arrives and tracked through every later edit; when the
// upload finishes the placeholder's current range is replaced. This keeps each
// image at the spot it was dropped even if the author keeps typing, and keeps
// several images pasted at once in order.

type Pending = { id: number; from: number; to: number };

const addPending = StateEffect.define<Pending>();
const removePending = StateEffect.define<number>();

const pendingField = StateField.define<Pending[]>({
	create: () => [],
	update(value, tr) {
		let next = value;
		if (tr.docChanged) {
			next = next.map((p) => ({
				id: p.id,
				from: tr.changes.mapPos(p.from, -1),
				to: tr.changes.mapPos(p.to, 1)
			}));
		}
		for (const effect of tr.effects) {
			if (effect.is(addPending)) next = [...next, effect.value];
			else if (effect.is(removePending)) next = next.filter((p) => p.id !== effect.value);
		}
		return next;
	}
});

let nextId = 0;

export function imageUploadExtension(universeId: string): Extension {
	// Replace a placeholder's current (mapped) range; a null replacement just
	// removes it, the failed-upload case.
	function clear(view: EditorView, id: number, replacement: string | null) {
		// The upload can resolve after the editor was torn down (a scene switch
		// mid-upload); dispatching on a destroyed view throws. Its DOM is detached
		// once destroyed, so skip the update.
		if (!view.dom.isConnected) return;
		const marker = view.state.field(pendingField).find((p) => p.id === id);
		if (!marker) return;
		view.dispatch({
			changes: { from: marker.from, to: marker.to, insert: replacement ?? '' },
			effects: removePending.of(id),
			scrollIntoView: replacement !== null
		});
	}

	async function resolve(view: EditorView, file: File, id: number) {
		try {
			const form = new FormData();
			form.set('file', file);
			form.set('kind', 'inline');
			form.set('universeId', universeId);
			const response = await fetch('/api/assets', { method: 'POST', body: form });
			if (!response.ok) {
				clear(view, id, null);
				return;
			}
			const { path } = (await response.json()) as { path: string };
			clear(view, id, `![${file.name}](${path})\n`);
		} catch {
			clear(view, id, null);
		}
	}

	// Insert a placeholder per file at consecutive positions, then start the
	// uploads. Done synchronously in the event handler so the placeholders keep
	// the files' original order before any upload resolves.
	function start(view: EditorView, files: File[], pos: number) {
		let at = pos;
		for (const file of files) {
			const id = nextId++;
			const placeholder = `![Uploading ${file.name}...]()\n`;
			view.dispatch({
				changes: { from: at, insert: placeholder },
				effects: addPending.of({ id, from: at, to: at + placeholder.length }),
				scrollIntoView: true
			});
			at += placeholder.length;
			void resolve(view, file, id);
		}
	}

	function imageFiles(data: DataTransfer | null): File[] {
		return [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'));
	}

	return [
		pendingField,
		EditorView.domEventHandlers({
			paste(event, view) {
				const files = imageFiles(event.clipboardData);
				if (files.length === 0) return false;
				event.preventDefault();
				start(view, files, view.state.selection.main.head);
				return true;
			},
			drop(event, view) {
				const files = imageFiles(event.dataTransfer);
				if (files.length === 0) return false;
				event.preventDefault();
				const pos =
					view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
					view.state.selection.main.head;
				start(view, files, pos);
				return true;
			}
		})
	];
}
