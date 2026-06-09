import type { CompletionRequest, Connection, Provider, StreamEvent } from './types';

// The OpenAI-compatible adapter: the only provider in the first cut. It speaks
// /v1/chat/completions, the de-facto shape Ollama, vLLM, hosted APIs, and
// Anthropic's compatibility endpoint all expose. A native Claude adapter slots
// behind the same Provider interface later.

function endpointUrl(endpoint: string): string {
	// Accept a bare base URL, a base ending in /v1, or a full completions URL,
	// and normalise to the chat-completions path.
	const trimmed = endpoint.replace(/\/+$/, '');
	if (trimmed.endsWith('/chat/completions')) return trimmed;
	if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
	return `${trimmed}/v1/chat/completions`;
}

function headers(conn: Connection): Record<string, string> {
	const h: Record<string, string> = { 'content-type': 'application/json' };
	// Local endpoints (Ollama) need no key; only send one when set.
	if (conn.apiKey) h['authorization'] = `Bearer ${conn.apiKey}`;
	return h;
}

function requestBody(req: CompletionRequest, stream: boolean): string {
	return JSON.stringify({
		model: req.model,
		messages: req.messages,
		max_tokens: req.maxTokens,
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		stream
	});
}

function truncate(text: string, max = 300): string {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

// Parse an OpenAI streaming response: newline-delimited "data: {json}" frames,
// terminated by "data: [DONE]". Content arrives as choices[0].delta.content.
async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<StreamEvent> {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of body) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, newline).replace(/\r$/, '');
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (data === '[DONE]') {
				yield { type: 'done' };
				return;
			}
			if (!data) continue;
			let json: unknown;
			try {
				json = JSON.parse(data);
			} catch {
				continue;
			}
			const delta = (json as { choices?: { delta?: { content?: unknown } }[] })?.choices?.[0]?.delta
				?.content;
			if (typeof delta === 'string' && delta.length > 0) {
				yield { type: 'token', text: delta };
			}
		}
	}
	// The stream ended without an explicit [DONE]; close it out anyway.
	yield { type: 'done' };
}

export const openaiProvider: Provider = {
	async *chatStream(req, conn, http, signal) {
		let res;
		try {
			res = await http(endpointUrl(conn.endpoint), {
				method: 'POST',
				headers: headers(conn),
				body: requestBody(req, true),
				signal
			});
		} catch (err) {
			yield { type: 'error', message: err instanceof Error ? err.message : 'request failed' };
			return;
		}
		if (res.status < 200 || res.status >= 300) {
			yield {
				type: 'error',
				message: `Endpoint returned ${res.status}: ${truncate(await res.text())}`
			};
			return;
		}
		yield* parseSse(res.body);
	},

	async complete(req, conn, http, signal) {
		const res = await http(endpointUrl(conn.endpoint), {
			method: 'POST',
			headers: headers(conn),
			body: requestBody(req, false),
			signal
		});
		const text = await res.text();
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Endpoint returned ${res.status}: ${truncate(text)}`);
		}
		const json = JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] };
		const content = json?.choices?.[0]?.message?.content;
		return typeof content === 'string' ? content : '';
	},

	async probe(conn, model, http, signal) {
		let res;
		try {
			res = await http(endpointUrl(conn.endpoint), {
				method: 'POST',
				headers: headers(conn),
				body: JSON.stringify({
					model,
					messages: [{ role: 'user', content: 'ping' }],
					max_tokens: 1,
					stream: true
				}),
				signal
			});
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : 'request failed' };
		}
		if (res.status < 200 || res.status >= 300) {
			return {
				ok: false,
				reason: `Endpoint returned ${res.status}: ${truncate(await res.text())}`
			};
		}
		// An endpoint that honours stream:true answers as text/event-stream;
		// one that ignores it returns buffered JSON. Tool support is not probed
		// here - the tool surface is deferred, so we do not claim it.
		const supportsStreaming = (res.headers['content-type'] ?? '').includes('text/event-stream');
		try {
			for await (const _chunk of res.body) {
				void _chunk;
			}
		} catch {
			// Draining is best-effort; the probe already succeeded.
		}
		return { ok: true, supportsStreaming, supportsTools: false };
	}
};
