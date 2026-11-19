// Text with every line break as a plain newline, the way the editor reads it:
// CodeMirror treats \r\n and a lone \r as one line break each.
export function toLf(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

// Where an offset in `text` lands in toLf(text). An offset between \r and \n
// lands on the newline that replaces them.
export function lfOffset(text: string, offset: number): number {
	let dropped = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === '\r' && text[i + 1] === '\n') dropped++;
	}
	return offset - dropped;
}
