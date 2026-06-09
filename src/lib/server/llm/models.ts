import type { Database } from '../auth';
import { resolveLlmConfig } from './config';
import { egressHttpRequest, egressPolicy } from './egress';
import { openaiProvider } from './providers/openai';
import type { Connection, HttpRequest, Provider } from './providers/types';

// Endpoint setup helpers, all through the same egress guard as completions, for
// the account Assistant settings (UI deferred):
//  - model discovery (GET /v1/models), so the writer picks from a dropdown
//    instead of typing a model name;
//  - a "test connection" that sends a tiny prompt and returns the model's reply,
//    so the writer sees it actually works (the SMTP "send a test" analogue).
// Each takes the submitted endpoint/key (or the saved config) and works before
// the master toggle is on, since the writer is mid-setup.

export type ModelListResult = { ok: true; models: string[] } | { ok: false; reason: string };

// Test seam, mirroring the gateway: production passes neither.
export type DiscoveryDeps = { provider?: Provider; http?: HttpRequest };

export async function listEndpointModels(
	db: Database,
	conn: Connection,
	deps: DiscoveryDeps = {}
): Promise<ModelListResult> {
	if (!conn.endpoint.trim()) return { ok: false, reason: 'Configure an endpoint first.' };
	const policy = await egressPolicy(db);
	const http = deps.http ?? egressHttpRequest(policy);
	const provider = deps.provider ?? openaiProvider;
	try {
		return { ok: true, models: await provider.listModels(conn, http) };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : 'Could not reach the endpoint.'
		};
	}
}

// Discover models from the account's saved config. Works before the master
// toggle is on (the writer is mid-setup); only an endpoint is required.
export async function discoverModels(
	db: Database,
	userId: string,
	deps: DiscoveryDeps = {}
): Promise<ModelListResult> {
	const { config } = await resolveLlmConfig(db, userId);
	return listEndpointModels(db, { endpoint: config.endpoint, apiKey: config.apiKey }, deps);
}

export type TestConnectionResult = { ok: true; reply: string } | { ok: false; reason: string };

// Send a tiny prompt to the chosen model and return its reply, confirming the
// endpoint, key, and model all work together.
export async function testEndpointConnection(
	db: Database,
	conn: Connection,
	model: string,
	deps: DiscoveryDeps = {}
): Promise<TestConnectionResult> {
	if (!conn.endpoint.trim()) return { ok: false, reason: 'Configure an endpoint first.' };
	if (!model.trim()) return { ok: false, reason: 'Choose a model to test.' };
	const policy = await egressPolicy(db);
	const http = deps.http ?? egressHttpRequest(policy);
	const provider = deps.provider ?? openaiProvider;
	try {
		const response = await provider.respond(
			{
				model,
				maxTokens: 64,
				messages: [
					{
						role: 'system',
						content: 'This is a connection test. Reply in one short, friendly sentence.'
					},
					{ role: 'user', content: 'Are you receiving this?' }
				]
			},
			conn,
			http
		);
		const reply = response.content.trim();
		return { ok: true, reply: reply || '(the model replied with no text)' };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : 'Could not reach the endpoint.'
		};
	}
}

// Test the account's saved config; the model defaults to the chat model, then
// any configured model.
export async function testAccountConnection(
	db: Database,
	userId: string,
	model?: string,
	deps: DiscoveryDeps = {}
): Promise<TestConnectionResult> {
	const { config } = await resolveLlmConfig(db, userId);
	const chosen = model?.trim() || config.models.chat || Object.values(config.models)[0] || '';
	return testEndpointConnection(
		db,
		{ endpoint: config.endpoint, apiKey: config.apiKey },
		chosen,
		deps
	);
}
