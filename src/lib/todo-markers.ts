// Detection for the plain-text marker form: a line whose first non-space
// characters are "TODO:". Pure text in, offsets out; the editor highlights
// the ranges and the story panel lists them. Shared by client and server
// so the two always agree.

export type TodoLine = {
	// Offsets of the whole line within the text.
	from: number;
	to: number;
	// The line's text after the "TODO:" prefix, trimmed.
	text: string;
};

export function findTodoLines(body: string): TodoLine[] {
	const found: TodoLine[] = [];
	let offset = 0;
	for (const line of body.split('\n')) {
		const match = /^(\s*)TODO:(.*)$/.exec(line);
		if (match) {
			found.push({
				from: offset,
				to: offset + line.length,
				text: match[2].trim()
			});
		}
		offset += line.length + 1;
	}
	return found;
}
