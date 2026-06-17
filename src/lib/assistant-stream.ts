// Server-Sent Event framing for the Assistant's streamed replies. The chat and
// recap endpoints both send `data:` frames separated by a blank line; this
// pulls the complete frames out of a growing buffer and hands back the
// incomplete tail to carry into the next read.

/**
 * Extracts complete SSE `data:` frames from the buffer, JSON-parsing each
 * payload. Returns the parsed events and the leftover tail (an unfinished
 * frame) to prepend before the next chunk. The caller types the payload.
 */
export function parseSseFrames<T>(buffer: string): { events: T[]; rest: string } {
	const frames = buffer.split('\n\n');
	const rest = frames.pop() ?? '';
	const events: T[] = [];
	for (const frame of frames) {
		const line = frame.trim();
		if (!line.startsWith('data:')) continue;
		const json = line.slice(5).trim();
		if (!json) continue;
		events.push(JSON.parse(json) as T);
	}
	return { events, rest };
}
