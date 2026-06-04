import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

// Paste or drop an image into the prose: it uploads and lands as a
// markdown image pointing at the app-served path. Markdown is the stored
// form, so exports carry the reference as plain text.
export function imageUploadExtension(universeId: string): Extension {
	async function upload(view: EditorView, file: File, pos: number) {
		const form = new FormData();
		form.set('file', file);
		form.set('kind', 'inline');
		form.set('universeId', universeId);
		const response = await fetch('/api/assets', { method: 'POST', body: form });
		if (!response.ok) return;
		const { path } = (await response.json()) as { path: string };
		view.dispatch({
			changes: { from: pos, insert: `![${file.name}](${path})\n` },
			scrollIntoView: true
		});
	}

	function imageFiles(data: DataTransfer | null): File[] {
		return [...(data?.files ?? [])].filter((file) => file.type.startsWith('image/'));
	}

	return EditorView.domEventHandlers({
		paste(event, view) {
			const files = imageFiles(event.clipboardData);
			if (files.length === 0) return false;
			event.preventDefault();
			const pos = view.state.selection.main.head;
			for (const file of files) void upload(view, file, pos);
			return true;
		},
		drop(event, view) {
			const files = imageFiles(event.dataTransfer);
			if (files.length === 0) return false;
			event.preventDefault();
			const pos =
				view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
			for (const file of files) void upload(view, file, pos);
			return true;
		}
	});
}
