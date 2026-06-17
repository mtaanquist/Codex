import { describe, it, expect } from 'vitest';
import { parseSseFrames } from './assistant-stream';

type Event = { type: string; text?: string };

describe('parseSseFrames', () => {
	it('parses complete frames and keeps the tail', () => {
		const { events, rest } = parseSseFrames<Event>(
			'data: {"type":"token","text":"He"}\n\ndata: {"type":"token","text":"llo"}\n\ndata: {"type":"to'
		);
		expect(events).toEqual([
			{ type: 'token', text: 'He' },
			{ type: 'token', text: 'llo' }
		]);
		expect(rest).toBe('data: {"type":"to');
	});

	it('returns no events when only a partial frame is buffered', () => {
		const { events, rest } = parseSseFrames<Event>('data: {"type":"tok');
		expect(events).toEqual([]);
		expect(rest).toBe('data: {"type":"tok');
	});

	it('ignores non-data and empty frames', () => {
		const { events, rest } = parseSseFrames<Event>(
			': comment\n\ndata:\n\ndata: {"type":"done"}\n\n'
		);
		expect(events).toEqual([{ type: 'done' }]);
		expect(rest).toBe('');
	});

	it('tolerates whitespace around the data payload', () => {
		const { events } = parseSseFrames<Event>('data:   {"type":"token","text":"x"}  \n\n');
		expect(events).toEqual([{ type: 'token', text: 'x' }]);
	});
});
