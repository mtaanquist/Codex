import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import {
	billedUsage,
	type Connection,
	type HttpRequest,
	type Provider,
	type ProviderResponse,
	type StreamEvent,
	type TokenUsage
} from './types';
import { isTransientFailure } from '../gateway';

// Recorded endpoint replies, one file each, replayed through both adapter paths
// (the live stream and the buffered reply) whole, in small chunks, and cut off
// at every event boundary. Every replay is held to the same rules, so a new
// edge case is a new file in transcripts/, not a new test.
//
// A file opens with "# key: value" lines, then a blank line, then the body:
//   outcome  reply (a usable reply), retry (a failure worth sending again) or
//            fail (a failure a resend would repeat)
//   text     the reply's text; finish its finish reason; tools the tool calls
//   status   the HTTP status (200); content-type (text/event-stream)

type Transcript = {
	provider: 'anthropic' | 'openai';
	name: string;
	header: Record<string, string>;
	status: number;
	contentType: string;
	body: string;
};

const DIR = join(import.meta.dirname, 'transcripts');
const PROVIDERS: Record<Transcript['provider'], Provider> = {
	anthropic: anthropicProvider,
	openai: openaiProvider
};

function load(): Transcript[] {
	const out: Transcript[] = [];
	for (const provider of ['anthropic', 'openai'] as const) {
		for (const file of readdirSync(join(DIR, provider)).sort()) {
			const raw = readFileSync(join(DIR, provider, file), 'utf8');
			const split = raw.indexOf('\n\n');
			const header: Record<string, string> = {};
			for (const line of raw.slice(0, split).split('\n')) {
				const match = /^# ([\w-]+):\s?(.*)$/.exec(line);
				if (match) header[match[1]] = match[2];
			}
			out.push({
				provider,
				name: file.replace(/\.sse$/, ''),
				header,
				status: Number(header.status ?? 200),
				contentType: header['content-type'] ?? 'text/event-stream',
				body: raw.slice(split + 2)
			});
		}
	}
	return out;
}

// What the body itself says was billed: the input side and the final output
// count, where the endpoint reported them.
function reported(t: Transcript, body: string): { input?: number; output?: number } {
	const result: { input?: number; output?: number } = {};
	for (const line of body.split(/\r?\n/)) {
		if (!line.startsWith('data:')) continue;
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line.slice(5));
		} catch {
			continue;
		}
		if (t.provider === 'anthropic') {
			const usage = (frame.message as { usage?: Record<string, unknown> })?.usage;
			if (frame.type === 'message_start' && usage) {
				result.input = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
					.map((key) => Number(usage[key] ?? 0))
					.reduce((a, b) => a + b, 0);
			}
			const output = Number((frame.usage as { output_tokens?: unknown })?.output_tokens);
			if (frame.type === 'message_delta' && Number.isFinite(output)) result.output = output;
		} else {
			const usage = frame.usage as { prompt_tokens?: number; completion_tokens?: number };
			if (usage?.prompt_tokens !== undefined) result.input = usage.prompt_tokens;
			if (usage?.completion_tokens !== undefined) result.output = usage.completion_tokens;
		}
	}
	return result;
}

// Spend is what the endpoint reported (the output count exactly), and is
// marked estimated exactly when the output count is the adapter's own guess.
function checkUsage(
	billed: TokenUsage | undefined,
	counts: { input?: number; output?: number },
	where: string
) {
	if (counts.input === undefined) return;
	expect(billed, `${where}: billed`).toBeDefined();
	// A server tool (web search) raises the input count in a later frame than
	// the one read here, so the input side is a floor.
	expect(billed!.promptTokens, `${where}: prompt`).toBeGreaterThanOrEqual(counts.input);
	if (counts.output !== undefined) {
		expect(billed!.completionTokens, `${where}: output`).toBe(counts.output);
		expect(billed!.estimated ?? false, `${where}: estimated`).toBe(false);
	} else {
		expect(billed!.estimated, `${where}: estimated`).toBe(true);
	}
}

function chunks(body: string, sizes: (i: number) => number): Uint8Array[] {
	const bytes = new TextEncoder().encode(body);
	const out: Uint8Array[] = [];
	for (let at = 0, i = 0; at < bytes.length; i++) {
		const size = Math.max(1, sizes(i));
		out.push(bytes.slice(at, at + size));
		at += size;
	}
	return out;
}

function http(t: Transcript, parts: Uint8Array[]): HttpRequest {
	return async () => ({
		status: t.status,
		headers: { 'content-type': t.contentType },
		body: {
			async *[Symbol.asyncIterator]() {
				for (const part of parts) yield part;
			}
		},
		text: async () => new TextDecoder().decode(Buffer.concat(parts))
	});
}

const conn: Connection = { endpoint: 'https://endpoint.test', apiKey: 'key' };
const request = { model: 'test-model', messages: [], maxTokens: 64 };

type Outcome =
	| { kind: 'reply'; text: string; finish?: string; tools: string[]; usage?: TokenUsage }
	| { kind: 'error'; transient: boolean; message: string; usage?: TokenUsage };

async function buffered(t: Transcript, parts: Uint8Array[]): Promise<Outcome> {
	let response: ProviderResponse;
	try {
		response = await PROVIDERS[t.provider].respond(request, conn, http(t, parts));
	} catch (error) {
		return {
			kind: 'error',
			transient: isTransientFailure(error),
			message: String(error),
			usage: billedUsage(error)
		};
	}
	return {
		kind: 'reply',
		text: response.content,
		finish: response.finishReason,
		tools: response.toolCalls.map((call) => call.name),
		usage: response.usage
	};
}

async function streamed(t: Transcript, parts: Uint8Array[]): Promise<Outcome> {
	const events: StreamEvent[] = [];
	for await (const event of PROVIDERS[t.provider].chatStream(request, conn, http(t, parts)))
		events.push(event);
	const usage = events.findLast((e) => e.type === 'usage')?.usage;
	const last = events.at(-1);
	// One terminal event, at the end.
	expect(events.filter((e) => e.type === 'done' || e.type === 'error')).toHaveLength(1);
	if (last?.type === 'error')
		return {
			kind: 'error',
			transient: /^Endpoint returned (429|5\d\d)/.test(last.message),
			message: last.message,
			usage
		};
	expect(last?.type).toBe('done');
	return {
		kind: 'reply',
		text: events.map((e) => (e.type === 'token' ? e.text : '')).join(''),
		finish: last?.type === 'done' ? last.finishReason : undefined,
		tools: [],
		usage
	};
}

const isStream = (t: Transcript) => t.contentType === 'text/event-stream' || t.contentType === '';

// The buffered path is the only one OpenAI-style endpoints stream on the
// live side; their buffered call asks for one JSON body, so the SSE files
// replay there only for a failed status.
const paths = (t: Transcript) =>
	[
		['stream', streamed],
		...(t.provider === 'anthropic' || t.status !== 200 ? [['buffered', buffered]] : [])
	] as [string, (t: Transcript, parts: Uint8Array[]) => Promise<Outcome>][];

function checkWhole(t: Transcript, path: string, outcome: Outcome) {
	const where = `${t.provider}/${t.name} (${path})`;
	const expected = t.header.outcome;
	// The live stream has no reply to give for a body that is not a stream.
	if (path === 'stream' && expected === 'reply' && !isStream(t)) {
		expect(outcome.kind, where).toBe('error');
		return;
	}
	if (expected === 'reply') {
		expect(outcome, where).toMatchObject({ kind: 'reply', text: t.header.text ?? '' });
		if (outcome.kind !== 'reply') return;
		expect(outcome.finish, `${where}: finish`).toBe(t.header.finish);
		if (path === 'buffered')
			expect(outcome.tools, `${where}: tools`).toEqual(
				t.header.tools ? t.header.tools.split(',') : []
			);
		if (t.header.searches)
			expect(outcome.usage?.webSearchRequests, `${where}: searches`).toBe(
				Number(t.header.searches)
			);
	} else {
		expect(outcome.kind, where).toBe('error');
		// Only the buffered path is retried; the live stream shows the error.
		if (outcome.kind === 'error' && path === 'buffered')
			expect(outcome.transient, `${where}: worth a retry (${outcome.message})`).toBe(
				expected === 'retry'
			);
	}
	checkUsage(outcome.usage, reported(t, t.body), where);
}

// Where a stream can be cut: after each event, or after each line when the
// endpoint leaves out the blank lines.
function cuts(body: string): number[] {
	const out: number[] = [];
	const separator = /\r?\n\r?\n/.test(body) ? /\r?\n\r?\n/g : /\r?\n/g;
	for (const match of body.matchAll(separator)) {
		const at = match.index! + match[0].length;
		if (at < body.trimEnd().length) out.push(at);
	}
	return out;
}

const TRANSCRIPTS = load();

describe('stream transcripts', () => {
	it('has transcripts to replay', () => {
		expect(TRANSCRIPTS.length).toBeGreaterThan(20);
		for (const t of TRANSCRIPTS)
			expect(['reply', 'retry', 'fail'], t.name).toContain(t.header.outcome);
	});

	for (const t of TRANSCRIPTS) {
		describe(`${t.provider}/${t.name}`, () => {
			for (const [path, run] of paths(t)) {
				it(`${path}: whole`, async () => {
					checkWhole(
						t,
						path,
						await run(
							t,
							chunks(t.body, () => Infinity)
						)
					);
				});

				it(`${path}: the same in small chunks`, async () => {
					const whole = await run(
						t,
						chunks(t.body, () => Infinity)
					);
					// One byte at a time, then a fixed uneven pattern.
					for (const sizes of [() => 1, (i: number) => [3, 1, 7, 2, 5][i % 5]]) {
						expect(await run(t, chunks(t.body, sizes))).toEqual(whole);
					}
				});

				if (t.header.outcome === 'reply' && isStream(t)) {
					// A connection that drops before the endpoint said how the
					// reply ended is a failure worth a retry, never a finished
					// reply, and what it had billed is still counted.
					it(`${path}: cut at each event`, async () => {
						for (const at of cuts(t.body)) {
							const prefix = t.body.slice(0, at);
							const where = `${t.provider}/${t.name} (${path}) cut at ${at}`;
							const outcome = await run(
								t,
								chunks(prefix, () => Infinity)
							);
							const ended =
								t.provider === 'anthropic'
									? /"stop_reason":"\w+"/.test(prefix)
									: /"finish_reason":"\w+"/.test(prefix);
							if (ended) {
								expect(outcome.kind, where).toBe('reply');
							} else {
								expect(outcome, where).toMatchObject({ kind: 'error' });
								if (path === 'buffered' && outcome.kind === 'error')
									expect(outcome.transient, where).toBe(true);
							}
							checkUsage(outcome.usage, reported(t, prefix), where);
						}
					});
				}
			}
		});
	}
});
