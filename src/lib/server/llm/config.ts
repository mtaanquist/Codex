import { eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../auth';
import { stories, users } from '../db/schema';
import { decryptSecret, encryptSecret, secretsAvailable } from '../crypto';

// The Assistant's per-account and per-story configuration. The reserved
// users.llm_config and stories.llm_config jsonb columns hold this; both are
// inert {} until the writer configures the Assistant. Everything is optional on
// disk and normalised on read, the way preferences.ts treats its column.
//
// The account config is the source of truth (endpoint, key, budget, master
// switch); a story may only ever subtract - mute the Assistant, or pick a
// different model. A per-story override never lights the Assistant up when the
// account master is off; account-off is dark everywhere.

export const ASSISTANT_ROLES = ['continuation', 'coauthor', 'editor', 'reviewer', 'chat'] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

export type ModelMap = Partial<Record<AssistantRole, string>>;

// Stored in users.llm_config. The key is encrypted at rest (see crypto.ts), the
// same way the SMTP password is.
export type StoredAccountConfig = {
	// The master kill switch (the opt-in). Off by default; the writer flips it on
	// once and the Assistant becomes available across their stories.
	enabled: boolean;
	endpoint: string;
	apiKeyEnc: string | null;
	models: ModelMap;
	// The most tool calls the Assistant may make in one turn (tools are a later
	// surface; the value is carried now so the config shape is stable).
	toolCallBudget: number;
	// Capabilities detected by the "test connection" probe and stored with the
	// config; absent until a probe has run.
	supportsStreaming?: boolean;
	supportsTools?: boolean;
};

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
		endpoint: typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '',
		apiKeyEnc: typeof raw.apiKeyEnc === 'string' && raw.apiKeyEnc ? raw.apiKeyEnc : null,
		models: normaliseModels(raw.models),
		toolCallBudget: normaliseBudget(raw.toolCallBudget),
		supportsStreaming: normaliseCapability(raw.supportsStreaming),
		supportsTools: normaliseCapability(raw.supportsTools)
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
	endpoint: string;
	apiKey: string;
	models: ModelMap;
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
			endpoint: account.endpoint,
			apiKey: account.apiKeyEnc ? decryptSecret(account.apiKeyEnc) : '',
			models: { ...account.models, ...(override?.models ?? {}) },
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
	endpoint: string;
	hasKey: boolean;
	models: ModelMap;
	toolCallBudget: number;
	supportsStreaming?: boolean;
	supportsTools?: boolean;
};

export async function accountLlmView(db: Database, userId: string): Promise<AccountLlmView> {
	const c = await accountLlmConfig(db, userId);
	return {
		configured: c.endpoint.length > 0,
		enabled: c.enabled,
		endpoint: c.endpoint,
		hasKey: c.apiKeyEnc !== null,
		models: c.models,
		toolCallBudget: c.toolCallBudget,
		supportsStreaming: c.supportsStreaming,
		supportsTools: c.supportsTools
	};
}

export type SaveAccountInput = {
	enabled: boolean;
	endpoint: string;
	// Blank keeps the stored key, so the writer can edit other fields without
	// re-entering it (the SMTP/S3 pattern).
	apiKey: string;
	models: ModelMap;
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
	const endpoint = input.endpoint.trim();
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

	const value: StoredAccountConfig = {
		enabled: input.enabled,
		endpoint,
		apiKeyEnc,
		models: normaliseModels(input.models),
		toolCallBudget: normaliseBudget(input.toolCallBudget),
		...(input.supportsStreaming !== undefined
			? { supportsStreaming: input.supportsStreaming }
			: {}),
		...(input.supportsTools !== undefined ? { supportsTools: input.supportsTools } : {})
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
