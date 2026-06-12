import { eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../auth';
import { stories, users } from '../db/schema';
import { decryptSecret, encryptSecret, secretsAvailable } from '../crypto';
import { normaliseAssistantName, normalisePersona, type Persona } from './prompts/persona';
import { normaliseProviderId, providerPreset, type ProviderId } from './providers/presets';

// The Assistant's per-account and per-story configuration. The reserved
// users.llm_config and stories.llm_config jsonb columns hold this; both are
// inert {} until the writer configures the Assistant. Everything is optional on
// disk and normalised on read, the way preferences.ts treats its column.
//
// The account config is the source of truth (endpoint, key, budget, master
// switch); a story may only ever subtract - mute the Assistant, or pick a
// different model. A per-story override never lights the Assistant up when the
// account master is off; account-off is dark everywhere.

export const ASSISTANT_ROLES = ['continuation', 'coauthor', 'reviewer', 'chat'] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

export type ModelMap = Partial<Record<AssistantRole, string>>;

// Per-role request tuning, used by the Anthropic adapter: whether to ask for
// adaptive thinking, and an effort level. Both optional; absent means the
// provider's defaults. Other adapters ignore the whole map.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type RoleTuning = { thinking?: boolean; effort?: EffortLevel };
export type TuningMap = Partial<Record<AssistantRole, RoleTuning>>;

function normaliseTuning(raw: unknown): TuningMap {
	const out: TuningMap = {};
	if (raw && typeof raw === 'object') {
		for (const role of ASSISTANT_ROLES) {
			const value = (raw as Record<string, unknown>)[role];
			if (!value || typeof value !== 'object') continue;
			const tuning: RoleTuning = {};
			const { thinking, effort } = value as { thinking?: unknown; effort?: unknown };
			if (thinking === true) tuning.thinking = true;
			if (typeof effort === 'string' && (EFFORT_LEVELS as readonly string[]).includes(effort)) {
				tuning.effort = effort as EffortLevel;
			}
			if (Object.keys(tuning).length > 0) out[role] = tuning;
		}
	}
	return out;
}

// Stored in users.llm_config. The key is encrypted at rest (see crypto.ts), the
// same way the SMTP password is.
export type StoredAccountConfig = {
	// The master kill switch (the opt-in). Off by default; the writer flips it on
	// once and the Assistant becomes available across their stories.
	enabled: boolean;
	// The Assistant's display name and tone preset - a little personality. Both
	// cosmetic-to-the-task: the name is shown in the UI, the persona nudges tone.
	assistantName: string;
	persona: Persona;
	// Which provider the endpoint is: a preset (Anthropic, OpenAI, ...) or
	// 'custom' for a bring-your-own OpenAI-compatible endpoint. Configs saved
	// before this field existed normalise to 'custom' and behave as before.
	provider: ProviderId;
	endpoint: string;
	apiKeyEnc: string | null;
	models: ModelMap;
	// Per-role thinking and effort, consumed by the Anthropic adapter only.
	tuning: TuningMap;
	// The most tool calls the Assistant may make in one turn (tools are a later
	// surface; the value is carried now so the config shape is stable).
	toolCallBudget: number;
	// Capabilities detected by the "test connection" probe and stored with the
	// config; set by hand for an endpoint that cannot stream or call tools.
	supportsStreaming?: boolean;
	supportsTools?: boolean;
	// Per-token USD prices snapshotted at the last model discovery, for the
	// endpoints that report them (OpenRouter). Used to estimate costs on the
	// usage log; absent for endpoints that report no prices.
	modelPricing?: ModelPricing;
};

export type ModelPricing = Record<string, { prompt: number; completion: number }>;

function normalisePricing(raw: unknown): ModelPricing | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const out: ModelPricing = {};
	for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
		const prompt = Number((value as { prompt?: unknown })?.prompt);
		const completion = Number((value as { completion?: unknown })?.completion);
		if (Number.isFinite(prompt) && Number.isFinite(completion)) {
			out[model] = { prompt, completion };
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// Snapshot the prices a model discovery reported, replacing the previous
// snapshot (so switching endpoints does not leave stale prices behind).
export async function saveModelPricing(
	db: Database,
	userId: string,
	pricing: ModelPricing
): Promise<void> {
	await db
		.update(users)
		.set({
			llmConfig: sql`${users.llmConfig} || ${JSON.stringify({ modelPricing: pricing })}::jsonb`
		})
		.where(eq(users.id, userId));
}

// Stored in stories.llm_config: a mute and/or a model selection, nothing else.
export type StoredStoryOverride = {
	enabled?: false;
	models?: ModelMap;
};

const DEFAULT_TOOL_BUDGET = 8;
const MAX_TOOL_BUDGET = 100;

function normaliseModels(raw: unknown): ModelMap {
	const out: ModelMap = {};
	if (raw && typeof raw === 'object') {
		for (const role of ASSISTANT_ROLES) {
			const value = (raw as Record<string, unknown>)[role];
			if (typeof value === 'string' && value.trim()) out[role] = value.trim();
		}
	}
	return out;
}

function normaliseBudget(raw: unknown): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return DEFAULT_TOOL_BUDGET;
	return Math.min(Math.floor(raw), MAX_TOOL_BUDGET);
}

function normaliseCapability(raw: unknown): boolean | undefined {
	return raw === true ? true : raw === false ? false : undefined;
}

function normaliseAccount(raw: Record<string, unknown>): StoredAccountConfig {
	return {
		enabled: raw.enabled === true,
		assistantName: normaliseAssistantName(raw.assistantName),
		persona: normalisePersona(raw.persona),
		provider: normaliseProviderId(raw.provider),
		endpoint: typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '',
		apiKeyEnc: typeof raw.apiKeyEnc === 'string' && raw.apiKeyEnc ? raw.apiKeyEnc : null,
		models: normaliseModels(raw.models),
		tuning: normaliseTuning(raw.tuning),
		toolCallBudget: normaliseBudget(raw.toolCallBudget),
		supportsStreaming: normaliseCapability(raw.supportsStreaming),
		supportsTools: normaliseCapability(raw.supportsTools),
		modelPricing: normalisePricing(raw.modelPricing)
	};
}

function normaliseOverride(raw: Record<string, unknown>): StoredStoryOverride {
	const out: StoredStoryOverride = {};
	// Only a mute is meaningful; a story cannot turn the Assistant on.
	if (raw.enabled === false) out.enabled = false;
	const models = normaliseModels(raw.models);
	if (Object.keys(models).length > 0) out.models = models;
	return out;
}

// The gate every surface checks (see assistant.md "Gating and discoverability").
// Pure, so the truth table is easy to pin down in tests.
export type AssistantGate = {
	// An endpoint is set on the account.
	configured: boolean;
	// Configured and the master switch on.
	accountEnabled: boolean;
	// The Assistant tab is shown (per-story on/off lives here). Same condition as
	// accountEnabled; the tab stays even on a muted story, to un-mute.
	tabEnabled: boolean;
	// The in-editor and in-menu surfaces, and any actual generation, are live:
	// configured, account on, and this story not muted.
	surfacesEnabled: boolean;
};

export function assistantGate(
	account: StoredAccountConfig,
	override?: StoredStoryOverride
): AssistantGate {
	const configured = account.endpoint.length > 0;
	const accountEnabled = configured && account.enabled;
	const storyMuted = override?.enabled === false;
	return {
		configured,
		accountEnabled,
		tabEnabled: accountEnabled,
		surfacesEnabled: accountEnabled && !storyMuted
	};
}

// What the editor page load needs to decide what Assistant UI to render, with
// no key decryption: whether the tab shows, whether the in-editor surfaces are
// live, whether this story is muted, and the Assistant's display name for the
// tab. Mirrors the gate (see assistantGate) for the layout, the way the asset
// config feeds the pages that hide asset-backed features.
export type AssistantLayout = {
	tabEnabled: boolean;
	surfacesEnabled: boolean;
	muted: boolean;
	name: string;
};

export async function assistantLayout(
	db: Database,
	userId: string,
	storyId?: string
): Promise<AssistantLayout> {
	const account = await accountLlmConfig(db, userId);
	const override = storyId ? await storyOverride(db, storyId) : undefined;
	const gate = assistantGate(account, override);
	return {
		tabEnabled: gate.tabEnabled,
		surfacesEnabled: gate.surfacesEnabled,
		// The tab stays on a muted story to un-mute; tabEnabled-but-not-surfaces is
		// exactly the muted state (account on, this story off).
		muted: gate.tabEnabled && !gate.surfacesEnabled,
		// A blank name is allowed at rest; the surfaces show a default label.
		name: account.assistantName || 'Assistant'
	};
}

export async function accountLlmConfig(db: Database, userId: string): Promise<StoredAccountConfig> {
	const [row] = await db
		.select({ llmConfig: users.llmConfig })
		.from(users)
		.where(eq(users.id, userId));
	return normaliseAccount((row?.llmConfig ?? {}) as Record<string, unknown>);
}

async function storyOverride(db: Database, storyId: string): Promise<StoredStoryOverride> {
	const [row] = await db
		.select({ llmConfig: stories.llmConfig })
		.from(stories)
		.where(eq(stories.id, storyId));
	return normaliseOverride((row?.llmConfig ?? {}) as Record<string, unknown>);
}

// What the gateway runs with: the account config merged with the story override
// (story models win, the override can only mute), the key decrypted. The key is
// plaintext here and must not leave the server.
export type ResolvedConfig = {
	assistantName: string;
	persona: Persona;
	provider: ProviderId;
	endpoint: string;
	apiKey: string;
	models: ModelMap;
	tuning: TuningMap;
	toolCallBudget: number;
	supportsStreaming?: boolean;
	supportsTools?: boolean;
};

export type Resolved = {
	gate: AssistantGate;
	config: ResolvedConfig;
};

export async function resolveLlmConfig(
	db: Database,
	userId: string,
	storyId?: string
): Promise<Resolved> {
	const account = await accountLlmConfig(db, userId);
	const override = storyId ? await storyOverride(db, storyId) : undefined;
	const gate = assistantGate(account, override);
	return {
		gate,
		config: {
			assistantName: account.assistantName,
			persona: account.persona,
			provider: account.provider,
			endpoint: account.endpoint,
			apiKey: account.apiKeyEnc ? decryptSecret(account.apiKeyEnc) : '',
			models: { ...account.models, ...(override?.models ?? {}) },
			tuning: account.tuning,
			toolCallBudget: account.toolCallBudget,
			supportsStreaming: account.supportsStreaming,
			supportsTools: account.supportsTools
		}
	};
}

// A key-free view for the account settings page and the layout gate (deferred
// frontend); never exposes the key, only whether one is set.
export type AccountLlmView = {
	configured: boolean;
	enabled: boolean;
	assistantName: string;
	persona: Persona;
	provider: ProviderId;
	endpoint: string;
	hasKey: boolean;
	models: ModelMap;
	tuning: TuningMap;
	toolCallBudget: number;
	supportsStreaming?: boolean;
	supportsTools?: boolean;
	modelPricing?: ModelPricing;
};

export async function accountLlmView(db: Database, userId: string): Promise<AccountLlmView> {
	const c = await accountLlmConfig(db, userId);
	return {
		configured: c.endpoint.length > 0,
		enabled: c.enabled,
		assistantName: c.assistantName,
		persona: c.persona,
		provider: c.provider,
		endpoint: c.endpoint,
		hasKey: c.apiKeyEnc !== null,
		models: c.models,
		tuning: c.tuning,
		toolCallBudget: c.toolCallBudget,
		supportsStreaming: c.supportsStreaming,
		supportsTools: c.supportsTools,
		modelPricing: c.modelPricing
	};
}

export type SaveAccountInput = {
	enabled: boolean;
	assistantName: string;
	persona: Persona;
	// Defaults to 'custom' (a bring-your-own endpoint) when absent.
	provider?: ProviderId;
	endpoint: string;
	// Blank keeps the stored key, so the writer can edit other fields without
	// re-entering it (the SMTP/S3 pattern).
	apiKey: string;
	models: ModelMap;
	tuning?: TuningMap;
	toolCallBudget: number;
	supportsStreaming?: boolean;
	supportsTools?: boolean;
};

export type SaveResult = { ok: true } | { ok: false; reason: string };

export async function saveAccountLlmConfig(
	db: Database,
	userId: string,
	input: SaveAccountInput
): Promise<SaveResult> {
	const provider = normaliseProviderId(input.provider);
	// A preset owns its endpoint: the stored URL comes from the preset table, not
	// the form, so a stale or tampered field cannot point a preset elsewhere.
	const preset = providerPreset(provider);
	const endpoint = preset ? preset.baseUrl : input.endpoint.trim();
	if (endpoint) {
		let url: URL;
		try {
			url = new URL(endpoint);
		} catch {
			return { ok: false, reason: 'Enter a valid endpoint URL.' };
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return { ok: false, reason: 'The endpoint must be an http or https URL.' };
		}
	}

	const existing = await accountLlmConfig(db, userId);
	let apiKeyEnc = existing.apiKeyEnc;
	if (input.apiKey) {
		if (!secretsAvailable()) {
			return { ok: false, reason: 'Set APP_SECRET on the server before storing an API key.' };
		}
		apiKeyEnc = encryptSecret(input.apiKey);
	}

	// The Anthropic API always streams and calls tools, so a preset config never
	// carries a manual opt-out that would disable surfaces.
	const supportsStreaming = preset?.adapter === 'anthropic' ? true : input.supportsStreaming;
	const supportsTools = preset?.adapter === 'anthropic' ? true : input.supportsTools;
	const value: StoredAccountConfig = {
		enabled: input.enabled,
		assistantName: normaliseAssistantName(input.assistantName),
		persona: normalisePersona(input.persona),
		provider,
		endpoint,
		apiKeyEnc,
		models: normaliseModels(input.models),
		// Absent means "not part of this form", keeping the stored map (the
		// blank-api-key pattern); pass {} to clear it.
		tuning: input.tuning === undefined ? existing.tuning : normaliseTuning(input.tuning),
		toolCallBudget: normaliseBudget(input.toolCallBudget),
		...(supportsStreaming !== undefined ? { supportsStreaming } : {}),
		...(supportsTools !== undefined ? { supportsTools } : {})
	};
	// A jsonb merge, so any unknown keys (a future config field) survive.
	await db
		.update(users)
		.set({ llmConfig: sql`${users.llmConfig} || ${JSON.stringify(value)}::jsonb` })
		.where(eq(users.id, userId));
	return { ok: true };
}

// Sets or clears a story's override: a value writes the key, null removes it so
// the story falls back to the account again (the saveStoryPreferences pattern).
// enabled can only be false (mute) or null (clear); a story cannot turn the
// Assistant on against the account master.
export async function saveStoryLlmOverride(
	db: Database,
	storyId: string,
	patch: { enabled?: false | null; models?: ModelMap | null }
): Promise<void> {
	const set: Record<string, unknown> = {};
	const clear: string[] = [];
	if (patch.enabled === null) clear.push('enabled');
	else if (patch.enabled === false) set.enabled = false;
	if (patch.models === null) clear.push('models');
	else if (patch.models) set.models = normaliseModels(patch.models);

	let expression: SQL = sql`${stories.llmConfig} || ${JSON.stringify(set)}::jsonb`;
	for (const key of clear) {
		expression = sql`(${expression}) - ${key}::text`;
	}
	await db.update(stories).set({ llmConfig: expression }).where(eq(stories.id, storyId));
}
