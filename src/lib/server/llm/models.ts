import type { Database } from '../auth';
import { resolveLlmConfig, saveModelPricing, type ModelPricing } from './config';
import { egressHttpRequest, egressPolicy } from './egress';
import { providerFor } from './providers';
import type { ProviderId } from './providers/presets';
import type { Connection, HttpRequest, ModelInfo, Provider } from './providers/types';
import { pickModel } from './gateway';

// Endpoint setup helpers, all through the same egress guard as completions, for
// the account Assistant settings (UI deferred):
//  - model discovery (GET /v1/models), so the writer picks from a dropdown
//    instead of typing a model name;
//  - a "test connection" that sends a tiny prompt and returns the model's reply,
//    so the writer sees it actually works (the SMTP "send a test" analogue).
// Each takes the submitted endpoint/key (or the saved config) and works before
// the master toggle is on, since the writer is mid-setup.

export type ModelListResult = { ok: true; models: ModelInfo[] } | { ok: false; reason: string };

// Test seam, mirroring the gateway: production passes neither.
export type DiscoveryDeps = { provider?: Provider; http?: HttpRequest };

export async function listEndpointModels(
	db: Database,
	conn: Connection,
	providerId: ProviderId = 'custom',
	deps: DiscoveryDeps = {}
): Promise<ModelListResult> {
	if (!conn.endpoint.trim()) return { ok: false, reason: 'Configure an endpoint first.' };
	const policy = await egressPolicy(db);
	const http = deps.http ?? egressHttpRequest(policy);
	const provider = deps.provider ?? providerFor(providerId);
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
	const result = await listEndpointModels(
		db,
		{ endpoint: config.endpoint, apiKey: config.apiKey },
		config.provider,
		deps
	);
	// Snapshot any reported prices so the usage log can estimate costs; an
	// endpoint without prices clears the previous snapshot.
	if (result.ok) {
		const pricing: ModelPricing = {};
		for (const model of result.models) {
			if (model.pricing) pricing[model.id] = model.pricing;
		}
		await saveModelPricing(db, userId, pricing);
	}
	return result;
}

export type TestConnectionResult = { ok: true; reply: string } | { ok: false; reason: string };

// Send a tiny prompt to the chosen model and return its reply, confirming the
// endpoint, key, and model all work together.
export async function testEndpointConnection(
	db: Database,
	conn: Connection,
	model: string,
	providerId: ProviderId = 'custom',
	deps: DiscoveryDeps = {}
): Promise<TestConnectionResult> {
	if (!conn.endpoint.trim()) return { ok: false, reason: 'Configure an endpoint first.' };
	if (!model.trim()) return { ok: false, reason: 'Choose a model to test.' };
	const policy = await egressPolicy(db);
	const http = deps.http ?? egressHttpRequest(policy);
	const provider = deps.provider ?? providerFor(providerId);
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
	const chosen = model?.trim() || pickModel(config, 'chat');
	return testEndpointConnection(
		db,
		{ endpoint: config.endpoint, apiKey: config.apiKey },
		chosen,
		config.provider,
		deps
	);
}
