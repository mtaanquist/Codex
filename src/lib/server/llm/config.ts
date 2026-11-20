import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { stories, universes, users } from '../db/schema.ts';
import { decryptSecret, encryptSecret, secretsAvailable } from '../crypto.ts';
import { normaliseAssistantName, normalisePersona, type Persona } from './prompts/persona.ts';
import {
	adapterKind,
	normaliseProviderId,
	providerPreset,
	type ProviderId
} from './providers/presets.ts';
import { suggestedModel } from './providers/model-guide.ts';
import { RESERVED_PARAM_KEYS, reservedParamKeys } from './providers/reserved.ts';
import {
	ASSISTANT_ROLES,
	EFFORT_LEVELS,
	MAX_REPLY_TOKENS,
	MAX_TEMPERATURE,
	claudeEffort,
	modelTakesEffort,
	resolveRoleModel,
	type AssistantRole,
	type EffortLevel,
	type ExtraParams,
	type RoleTuning,
	type TuningMap
} from '../../assistant-tuning.ts';
import type { ChatModelInfo, ChatModelSettings } from '../../assistant-chat.ts';

// The Assistant's per-account and per-story configuration. The reserved
// users.llm_config and stories.llm_config jsonb columns hold this; both are
// inert {} until the writer configures the Assistant. Everything is optional on
// disk and normalised on read, the way preferences.ts treats its column.
//
// The account config is the source of truth (endpoint, key, budget, master
// switch); a story may only ever subtract - mute the Assistant, or pick a
// different model. A per-story override never lights the Assistant up when the
// account master is off; account-off is dark everywhere.

// The roles, the effort levels, and the bounds on each tuning value live in
// #lib/assistant-tuning, which the settings page can import too; re-exported
// here so server callers keep one import. 'utility' was added after the other
// four, so an older config has no utility model; pickModel's fallback keeps
// those accounts on the chat model, exactly as before.
export { ASSISTANT_ROLES, EFFORT_LEVELS };
export type { AssistantRole, EffortLevel, ExtraParams, RoleTuning, TuningMap };

export type ModelMap = Partial<Record<AssistantRole, string>>;

// The fields an adapter owns, which a stored parameter may never rewrite, live
// with the adapters (./providers/reserved) because they are wire-format
// knowledge. Re-exported here so callers of the config keep one import.
export { RESERVED_PARAM_KEYS, reservedParamKeys };

function normaliseExtraParams(raw: unknown): ExtraParams | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const out: ExtraParams = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!key.trim() || (RESERVED_PARAM_KEYS as readonly string[]).includes(key)) continue;
		if (value === undefined) continue;
		out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normaliseTuning(raw: unknown): TuningMap {
	const out: TuningMap = {};
	if (raw && typeof raw === 'object') {
		for (const role of ASSISTANT_ROLES) {
			const value = (raw as Record<string, unknown>)[role];
			if (!value || typeof value !== 'object') continue;
			const tuning: RoleTuning = {};
			const { thinking, effort, temperature, maxTokens, extraParams } = value as {
				thinking?: unknown;
				effort?: unknown;
				temperature?: unknown;
				maxTokens?: unknown;
				extraParams?: unknown;
			};
			if (thinking === true || thinking === false) tuning.thinking = thinking;
			if (typeof effort === 'string' && (EFFORT_LEVELS as readonly string[]).includes(effort)) {
				tuning.effort = effort as EffortLevel;
			}
			if (typeof temperature === 'number' && Number.isFinite(temperature)) {
				tuning.temperature = Math.min(Math.max(temperature, 0), MAX_TEMPERATURE);
			}
			if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens >= 1) {
				tuning.maxTokens = Math.min(Math.floor(maxTokens), MAX_REPLY_TOKENS);
			}
			const extras = normaliseExtraParams(extraParams);
			if (extras) tuning.extraParams = extras;
			if (Object.keys(tuning).length > 0) out[role] = tuning;
		}
	}
	return out;
}

// How many tools the Assistant is offered on a tool-enabled turn. 'full' offers
// the whole default catalogue; 'minimal' offers the three that matter most, for
// endpoints running a smaller local model that handles many tool schemas badly.
export const TOOL_PROFILES = ['full', 'minimal'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

function normaliseToolProfile(raw: unknown): ToolProfile {
	return raw === 'minimal' ? 'minimal' : 'full';
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
	// Per-role thinking, effort, temperature, reply length and extra parameters;
	// each adapter reads the ones it can act on.
	tuning: TuningMap;
	// Extra request fields for every role, merged into the body the
	// OpenAI-compatible adapter sends. A role's own extras lay over these.
	extraParams?: ExtraParams;
	// Let the provider run its own web search (the Claude API's server-side
	// tool). Off unless the writer turns it on, and even then only on a universe
	// marked as an established published setting, where canon is the thing a
	// search can settle. The search runs on the provider's servers, so it adds
	// no outbound traffic of Codex's own.
	webSearch: boolean;
	// The most tool calls the Assistant may make in one turn. Stored under the
	// toolCallLimit key: the older toolCallBudget key was written on every save
	// while no screen could set it, so it only ever holds the old default and is
	// ignored rather than rewritten.
	toolCallBudget: number;
	// Which tools a tool-enabled turn offers (see TOOL_PROFILES).
	toolProfile: ToolProfile;
	// Capabilities detected by the "test connection" probe and stored with the
	// config; set by hand for an endpoint that cannot stream or call tools.
	supportsStreaming?: boolean;
	supportsTools?: boolean;
	// Per-token USD prices. modelPricing is the snapshot from the last model
	// discovery, for the endpoints that report prices (OpenRouter), replaced
	// whenever discovery runs. modelPricingManual is what the writer typed, for
	// the many endpoints that report none (Claude, OpenAI, a local server), and
	// always wins (the modelContextManual pattern). Nothing else ever supplies a
	// price: a model in neither map has no known price.
	modelPricing?: ModelPricing;
	modelPricingManual?: ModelPricing;
	// How long Claude keeps a cached prompt prefix: five minutes unless the
	// writer chose an hour. Only the Anthropic adapter reads it.
	cacheTtl: CacheTtl;
	// Context windows in tokens, per model id. modelContext is the snapshot from
	// the last discovery, replaced whenever discovery runs; modelContextManual is
	// what the writer typed and always wins, because a local server's operative
	// window is what it was launched with, not what the model card claims.
	modelContext?: ModelContextMap;
	modelContextManual?: ModelContextMap;
	// The most one background review run may spend before it stops at the next
	// scene boundary, in USD. Absent means no ceiling. Only meaningful when the
	// model has a price in modelPricing; without one a run cannot be priced, and
	// says so rather than stopping or carrying on silently.
	spendCapUsd?: number;
	// What a pre-flight estimate has to reach before the confirm step turns into
	// a warning, in USD. Absent means the default below.
	spendWarnUsd?: number;
};

// The estimate warns above this when the writer has set no figure of their own.
export const DEFAULT_SPEND_WARN_USD = 2;

function normaliseUsd(raw: unknown): number | undefined {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export type ModelContextMap = Record<string, number>;

export type ModelPricing = Record<string, { prompt: number; completion: number }>;

export const CACHE_TTLS = ['5m', '1h'] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];

function normaliseCacheTtl(raw: unknown): CacheTtl {
	return raw === '1h' ? '1h' : '5m';
}

// A price is kept only when both halves are real, non-negative numbers: a
// negative or half-entered price would make a run look cheaper than it is.
function normalisePricing(raw: unknown): ModelPricing | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const out: ModelPricing = {};
	for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== 'object') continue;
		const { prompt, completion } = value as { prompt?: unknown; completion?: unknown };
		if (typeof prompt !== 'number' || typeof completion !== 'number') continue;
		if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
		if (prompt < 0 || completion < 0) continue;
		out[model] = { prompt, completion };
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// The prices everything downstream reads: the discovered snapshot with the
// writer's own entries laid over it.
export function effectivePricing(config: {
	modelPricing?: ModelPricing;
	modelPricingManual?: ModelPricing;
}): ModelPricing | undefined {
	const merged = { ...(config.modelPricing ?? {}), ...(config.modelPricingManual ?? {}) };
	return Object.keys(merged).length > 0 ? merged : undefined;
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

function normaliseContext(raw: unknown): ModelContextMap | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const out: ModelContextMap = {};
	for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
		const tokens = Number(value);
		if (Number.isFinite(tokens) && tokens > 0) out[model] = Math.floor(tokens);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

// Snapshot the context windows a model discovery reported, replacing the
// previous snapshot. The writer's own entries live in a separate map and are
// not touched here, so a rediscovery never overwrites them.
export async function saveModelContext(
	db: Database,
	userId: string,
	context: ModelContextMap
): Promise<void> {
	await db
		.update(users)
		.set({
			llmConfig: sql`${users.llmConfig} || ${JSON.stringify({ modelContext: context })}::jsonb`
		})
		.where(eq(users.id, userId));
}

// Stored in stories.llm_config: a mute and/or a model selection, nothing else.
export type StoredStoryOverride = {
	enabled?: false;
	models?: ModelMap;
};

export const DEFAULT_TOOL_BUDGET = 20;
export const MAX_TOOL_BUDGET = 100;

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
		extraParams: normaliseExtraParams(raw.extraParams),
		webSearch: raw.webSearch === true,
		toolCallBudget: normaliseBudget(raw.toolCallLimit),
		toolProfile: normaliseToolProfile(raw.toolProfile),
		supportsStreaming: normaliseCapability(raw.supportsStreaming),
		supportsTools: normaliseCapability(raw.supportsTools),
		modelPricing: normalisePricing(raw.modelPricing),
		modelPricingManual: normalisePricing(raw.modelPricingManual),
		cacheTtl: normaliseCacheTtl(raw.cacheTtl),
		modelContext: normaliseContext(raw.modelContext),
		modelContextManual: normaliseContext(raw.modelContextManual),
		spendCapUsd: normaliseUsd(raw.spendCapUsd),
		spendWarnUsd: normaliseUsd(raw.spendWarnUsd)
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

// What a request is about, for the settings that can differ by universe and
// story. A story brings its own universe; universeId is for work with no one
// story (a universe chat, a pass over a universe's entries, a character arc).
export type LlmScope = { storyId?: string; universeId?: string };

// What a scope adds to the account's settings: the story's mute, and the
// models chosen on the story and on its universe (each empty when nothing is
// set there). The universe is the story's own when a story is given. Models
// count only from the user's own story and universe; the mute is read
// whoever owns the story, since it can only switch things off.
async function scopeOverrides(
	db: Database,
	userId: string,
	scope: LlmScope
): Promise<{ override?: StoredStoryOverride; universe: ModelMap; story: ModelMap }> {
	const universeModels = sql<unknown>`${universes.llmConfig} -> 'models'`;
	if (scope.storyId) {
		const [row] = await db
			.select({
				llmConfig: stories.llmConfig,
				universeModels,
				storyOwner: stories.ownerId,
				universeOwner: universes.ownerId
			})
			.from(stories)
			.innerJoin(universes, eq(universes.id, stories.universeId))
			.where(eq(stories.id, scope.storyId));
		const override = normaliseOverride((row?.llmConfig ?? {}) as Record<string, unknown>);
		return {
			override,
			universe: row?.universeOwner === userId ? normaliseModels(row.universeModels) : {},
			story: row?.storyOwner === userId ? (override.models ?? {}) : {}
		};
	}
	if (!scope.universeId) return { universe: {}, story: {} };
	const [row] = await db
		.select({ universeModels })
		.from(universes)
		.where(and(eq(universes.id, scope.universeId), eq(universes.ownerId, userId)));
	return { universe: normaliseModels(row?.universeModels), story: {} };
}

// The models chosen on the universe and on the story, for the settings pages.
export async function scopeModels(
	db: Database,
	userId: string,
	scope: LlmScope
): Promise<{ universe: ModelMap; story: ModelMap }> {
	const { universe, story } = await scopeOverrides(db, userId, scope);
	return { universe, story };
}

// Every model the user has chosen on a universe or a story, so the account
// page can offer a context window and a price for each.
export async function scopeChosenModels(db: Database, userId: string): Promise<string[]> {
	const [fromUniverses, fromStories] = await Promise.all([
		db
			.select({ models: sql<unknown>`${universes.llmConfig} -> 'models'` })
			.from(universes)
			.where(and(eq(universes.ownerId, userId), sql`${universes.llmConfig} ? 'models'`)),
		db
			.select({ models: sql<unknown>`${stories.llmConfig} -> 'models'` })
			.from(stories)
			.where(and(eq(stories.ownerId, userId), sql`${stories.llmConfig} ? 'models'`))
	]);
	const ids = [...fromUniverses, ...fromStories].flatMap((row) =>
		Object.values(normaliseModels(row.models))
	);
	return [...new Set(ids)].sort();
}

// The most specific choice wins, role by role: the story's, then the
// universe's, then the account's. A role's tuning stays the account's.
export function layerModels(account: ModelMap, universe: ModelMap, story: ModelMap): ModelMap {
	return { ...account, ...universe, ...story };
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
	extraParams?: ExtraParams;
	webSearch: boolean;
	toolCallBudget: number;
	toolProfile: ToolProfile;
	supportsStreaming?: boolean;
	supportsTools?: boolean;
	// Context windows per model id: the discovered snapshot with the writer's own
	// entries laid over it. A model missing here has an unknown window.
	modelContext: ModelContextMap;
	// Per-token prices for the runs that price what they spend: the discovered
	// snapshot with the writer's own entries laid over it. A model missing from
	// it has no known price at all.
	modelPricing?: ModelPricing;
	cacheTtl: CacheTtl;
	spendCapUsd?: number;
	spendWarnUsd?: number;
};

export type Resolved = {
	gate: AssistantGate;
	config: ResolvedConfig;
};

// scope is a story id, or a story and/or a universe (see LlmScope).
export async function resolveLlmConfig(
	db: Database,
	userId: string,
	scope?: string | LlmScope
): Promise<Resolved> {
	const where: LlmScope = typeof scope === 'string' ? { storyId: scope } : (scope ?? {});
	const account = await accountLlmConfig(db, userId);
	const chosen = await scopeOverrides(db, userId, where);
	const gate = assistantGate(account, chosen.override);
	return {
		gate,
		config: {
			assistantName: account.assistantName,
			persona: account.persona,
			provider: account.provider,
			endpoint: account.endpoint,
			apiKey: account.apiKeyEnc ? decryptSecret(account.apiKeyEnc) : '',
			models: layerModels(account.models, chosen.universe, chosen.story),
			tuning: account.tuning,
			extraParams: account.extraParams,
			webSearch: account.webSearch,
			toolCallBudget: account.toolCallBudget,
			toolProfile: account.toolProfile,
			supportsStreaming: account.supportsStreaming,
			supportsTools: account.supportsTools,
			modelContext: { ...(account.modelContext ?? {}), ...(account.modelContextManual ?? {}) },
			modelPricing: effectivePricing(account),
			cacheTtl: account.cacheTtl,
			spendCapUsd: account.spendCapUsd,
			spendWarnUsd: account.spendWarnUsd
		}
	};
}

// The model a role runs on; see resolveRoleModel for the order.
export function pickModel(config: ResolvedConfig, role: AssistantRole): string {
	return resolveRoleModel(config.models, role, suggestedModel(config.provider, role));
}

// A chat's own model and effort (the composer's model chip) laid over a role.
// Effort is a Claude setting, so any other provider or model drops it.
export function withRoleOverride(
	config: ResolvedConfig,
	role: AssistantRole,
	override: ChatModelSettings | undefined
): ResolvedConfig {
	const model = override?.model;
	const models = model ? { ...config.models, [role]: model } : config.models;
	// Only a Claude model that takes an effort level gets one; others reject it,
	// so a model picked for the chat also drops the account's effort for it.
	const takesEffort =
		adapterKind(config.provider) === 'anthropic' &&
		modelTakesEffort(resolveRoleModel(models, role, suggestedModel(config.provider, role)));
	const effort = takesEffort ? override?.effort : undefined;
	if (!model && !effort) return config;
	// The role's tuning (output cap, temperature, extra parameters) was set for
	// its own model, so another model starts from the defaults.
	const swapped = model !== undefined && model !== pickModel(config, role);
	let roleTuning = swapped ? {} : config.tuning[role];
	if (effort) roleTuning = { ...roleTuning, effort };
	else if (!takesEffort && roleTuning?.effort) {
		roleTuning = { ...roleTuning };
		delete roleTuning.effort;
	}
	return { ...config, models, tuning: { ...config.tuning, [role]: roleTuning } };
}

// What the composer's model chip shows when a chat has no setting of its own.
export function chatModelInfo(config: ResolvedConfig): ChatModelInfo {
	const model = pickModel(config, 'chat');
	const claude = adapterKind(config.provider) === 'anthropic';
	return {
		model,
		effort:
			claude && modelTakesEffort(model)
				? (claudeEffort('chat', model, config.tuning.chat) ?? null)
				: null,
		claude
	};
}

// The context window of the model this role runs on, in tokens; undefined when
// neither discovery nor the writer has supplied one.
export function modelContextWindow(
	config: ResolvedConfig,
	role: AssistantRole
): number | undefined {
	return config.modelContext[pickModel(config, role)];
}

// The extra request fields for a role: the account-wide object with the role's
// own laid over it, key by key, so a role can add to or replace a single
// parameter without restating the rest. Undefined when neither is set, which is
// what keeps a request byte-identical to one from before this existed.
export function roleExtraParams(
	config: ResolvedConfig,
	role: AssistantRole
): ExtraParams | undefined {
	const account = config.extraParams;
	const own = config.tuning[role]?.extraParams;
	if (!account && !own) return undefined;
	return { ...account, ...own };
}

// The reply length the writer set for this role, in tokens; undefined leaves
// the surface's own figure in place.
export function roleMaxTokens(config: ResolvedConfig, role: AssistantRole): number | undefined {
	return config.tuning[role]?.maxTokens;
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
	extraParams?: ExtraParams;
	webSearch: boolean;
	toolCallBudget: number;
	toolProfile: ToolProfile;
	supportsStreaming?: boolean;
	supportsTools?: boolean;
	// Kept apart for the settings screen: what discovery found, and what the
	// writer typed over it.
	modelPricing?: ModelPricing;
	modelPricingManual?: ModelPricing;
	cacheTtl: CacheTtl;
	modelContext?: ModelContextMap;
	modelContextManual?: ModelContextMap;
	spendCapUsd?: number;
	spendWarnUsd?: number;
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
		extraParams: c.extraParams,
		webSearch: c.webSearch,
		toolCallBudget: c.toolCallBudget,
		toolProfile: c.toolProfile,
		supportsStreaming: c.supportsStreaming,
		supportsTools: c.supportsTools,
		modelPricing: c.modelPricing,
		modelPricingManual: c.modelPricingManual,
		cacheTtl: c.cacheTtl,
		modelContext: c.modelContext,
		modelContextManual: c.modelContextManual,
		spendCapUsd: c.spendCapUsd,
		spendWarnUsd: c.spendWarnUsd
	};
}

export type SaveAccountInput = {
	enabled: boolean;
	assistantName: string;
	persona: Persona;
	// Absent keeps the stored provider, which is 'custom' (a bring-your-own
	// endpoint) for an account that has never picked one.
	provider?: ProviderId;
	endpoint: string;
	// Blank keeps the stored key, so the writer can edit other fields without
	// re-entering it (the SMTP/S3 pattern).
	apiKey: string;
	models: ModelMap;
	tuning?: TuningMap;
	// Account-wide extra request fields; absent keeps what is stored, {} clears
	// it (the modelContextManual pattern).
	extraParams?: ExtraParams;
	// Absent keeps the stored setting (the partial-save pattern).
	webSearch?: boolean;
	// Absent keeps the stored limit (or the default, when none was ever set).
	toolCallBudget?: number;
	// Absent keeps the stored profile (the partial-save pattern).
	toolProfile?: ToolProfile;
	// The writer's own context windows; absent keeps the stored map, {} clears it.
	modelContextManual?: ModelContextMap;
	// The writer's own per-token prices; absent keeps the stored map, {} clears
	// it. A provider or endpoint change clears it too (see saveAccountLlmConfig).
	modelPricingManual?: ModelPricing;
	// Absent keeps the stored setting (the partial-save pattern).
	cacheTtl?: CacheTtl;
	// The spend ceiling and the estimate's warning threshold, in USD. Absent
	// keeps what is stored; null, zero, or anything unreadable clears it.
	spendCapUsd?: number | null;
	spendWarnUsd?: number | null;
	supportsStreaming?: boolean;
	supportsTools?: boolean;
};

// On a switch, only what the caller carried over from the stored config is
// reset; a value it sent deliberately for the new provider is kept.
function carried(sent: unknown, stored: unknown): boolean {
	return JSON.stringify(sent) === JSON.stringify(stored);
}

function originOf(endpoint: string): string {
	try {
		return new URL(endpoint).origin;
	} catch {
		return endpoint;
	}
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).hostname;
	} catch {
		return endpoint;
	}
}

function withoutExtraParams(tuning: TuningMap): TuningMap {
	const out: TuningMap = {};
	for (const [role, own] of Object.entries(tuning) as [AssistantRole, RoleTuning][]) {
		const rest = { ...own };
		delete rest.extraParams;
		if (Object.keys(rest).length > 0) out[role] = rest;
	}
	return out;
}

export type SaveResult = { ok: true } | { ok: false; reason: string };

export async function saveAccountLlmConfig(
	db: Database,
	userId: string,
	input: SaveAccountInput
): Promise<SaveResult> {
	const existing = await accountLlmConfig(db, userId);
	// Absent keeps the stored provider (the partial-save pattern).
	const provider =
		input.provider === undefined ? existing.provider : normaliseProviderId(input.provider);
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

	// A parameter that would rewrite a field the adapter owns is refused rather
	// than dropped, so the writer finds out why it did not take effect.
	const reserved = new Set<string>();
	for (const extras of [
		input.extraParams,
		...ASSISTANT_ROLES.map((role) => input.tuning?.[role]?.extraParams)
	]) {
		if (extras) for (const key of reservedParamKeys(extras)) reserved.add(key);
	}
	if (reserved.size > 0) {
		const names = [...reserved].sort().join(', ');
		return {
			ok: false,
			reason: `Codex sets ${names} itself. Remove ${reserved.size === 1 ? 'it' : 'them'} from your extra settings.`
		};
	}

	// A key belongs to the provider and endpoint it was saved for, so a switch
	// never carries it over: it would be sent somewhere new. The discovered
	// snapshots describe the old endpoint too. A preset's URL is fixed, so only a
	// custom endpoint is compared, by host, and a first URL typed after the key
	// is not a switch. A provider switch also starts the model picks and the extra request
	// settings over, since they name the old provider's models and parameters.
	const providerChanged = provider !== existing.provider;
	const connectionChanged =
		providerChanged ||
		(!preset && !!existing.endpoint && originOf(endpoint) !== originOf(existing.endpoint));
	// Typed prices go only when the server itself changes: a new port or
	// scheme on the same machine is the same models at the same prices, and
	// dropping the prices there would leave the spend cap with nothing to meter.
	const serverChanged =
		providerChanged ||
		(!preset && !!existing.endpoint && hostOf(endpoint) !== hostOf(existing.endpoint));
	let apiKeyEnc = connectionChanged ? null : existing.apiKeyEnc;
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
	const tuning = input.tuning === undefined ? existing.tuning : normaliseTuning(input.tuning);
	const models = normaliseModels(input.models);
	const extraParams =
		input.extraParams === undefined ? undefined : (normaliseExtraParams(input.extraParams) ?? {});
	const pricingManual =
		input.modelPricingManual === undefined
			? undefined
			: (normalisePricing(input.modelPricingManual) ?? {});
	const value: StoredAccountConfig = {
		enabled: input.enabled,
		assistantName: normaliseAssistantName(input.assistantName),
		persona: normalisePersona(input.persona),
		provider,
		endpoint,
		apiKeyEnc,
		models: providerChanged && carried(models, existing.models) ? {} : models,
		// Absent means "not part of this form", keeping the stored map (the
		// blank-api-key pattern); pass {} to clear it.
		tuning:
			providerChanged && carried(tuning, existing.tuning) ? withoutExtraParams(tuning) : tuning,
		...(providerChanged &&
		(extraParams === undefined || carried(extraParams, existing.extraParams ?? {}))
			? { extraParams: {} }
			: extraParams === undefined
				? {}
				: { extraParams }),
		webSearch: input.webSearch === undefined ? existing.webSearch : input.webSearch === true,
		toolCallBudget:
			input.toolCallBudget === undefined
				? existing.toolCallBudget
				: normaliseBudget(input.toolCallBudget),
		toolProfile:
			input.toolProfile === undefined
				? existing.toolProfile
				: normaliseToolProfile(input.toolProfile),
		...(input.modelContextManual === undefined
			? {}
			: { modelContextManual: normaliseContext(input.modelContextManual) ?? {} }),
		// A typed price belongs to the endpoint it was looked up for: another
		// one can serve the same model id at another price, and the spend cap
		// would meter at the old one. So a connection change drops the typed
		// prices unless this save sent new ones, and the cap then reports the
		// model as unpriced until the writer enters them again.
		...(serverChanged &&
		(pricingManual === undefined || carried(pricingManual, existing.modelPricingManual ?? {}))
			? { modelPricingManual: {} }
			: pricingManual === undefined
				? {}
				: { modelPricingManual: pricingManual }),
		cacheTtl: input.cacheTtl === undefined ? existing.cacheTtl : normaliseCacheTtl(input.cacheTtl),
		...(supportsStreaming !== undefined ? { supportsStreaming } : {}),
		...(supportsTools !== undefined ? { supportsTools } : {})
	};
	// The spend fields are written as null rather than left out when they are
	// being cleared: a jsonb merge cannot delete a key by omitting it.
	const spend: Record<string, number | null> = {};
	if (input.spendCapUsd !== undefined) spend.spendCapUsd = normaliseUsd(input.spendCapUsd) ?? null;
	if (input.spendWarnUsd !== undefined) {
		spend.spendWarnUsd = normaliseUsd(input.spendWarnUsd) ?? null;
	}
	// What the last discovery reported describes the old provider's models.
	const snapshots = connectionChanged ? { modelPricing: {}, modelContext: {} } : {};
	// A jsonb merge, so any unknown keys (a future config field) survive.
	// The limit is written only when the writer set it, under its own key (see
	// StoredAccountConfig), so an account that never chose one follows the
	// default.
	const { toolCallBudget, ...rest } = value;
	const limit = input.toolCallBudget === undefined ? {} : { toolCallLimit: toolCallBudget };
	const stored: Record<string, unknown> = { ...rest, ...limit, ...spend, ...snapshots };
	await db.transaction(async (tx) => {
		await tx
			.update(users)
			.set({ llmConfig: sql`${users.llmConfig} || ${JSON.stringify(stored)}::jsonb` })
			.where(eq(users.id, userId));
		if (providerChanged) {
			// The picks on universes and stories name the old provider's models
			// too, and would be sent to the new one. A story's mute stays.
			await tx
				.update(universes)
				.set({
					llmConfig: sql`${universes.llmConfig} - 'models'`,
					updatedAt: sql`${universes.updatedAt}`
				})
				.where(and(eq(universes.ownerId, userId), sql`${universes.llmConfig} ? 'models'`));
			await tx
				.update(stories)
				.set({
					llmConfig: sql`${stories.llmConfig} - 'models'`,
					updatedAt: sql`${stories.updatedAt}`
				})
				.where(and(eq(stories.ownerId, userId), sql`${stories.llmConfig} ? 'models'`));
		}
	});
	return { ok: true };
}

// Replaces the models chosen for a universe; an empty map clears them, so the
// universe runs on the account's again. The caller checks ownership.
export async function saveUniverseModels(
	db: Database,
	universeId: string,
	models: ModelMap
): Promise<void> {
	const clean = normaliseModels(models);
	const expression: SQL =
		Object.keys(clean).length > 0
			? sql`${universes.llmConfig} || ${JSON.stringify({ models: clean })}::jsonb`
			: sql`${universes.llmConfig} - 'models'`;
	await db
		.update(universes)
		.set({ llmConfig: expression, updatedAt: sql`${universes.updatedAt}` })
		.where(eq(universes.id, universeId));
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
	const models = patch.models ? normaliseModels(patch.models) : undefined;
	if (patch.models === null || (models && Object.keys(models).length === 0)) clear.push('models');
	else if (models) set.models = models;

	let expression: SQL = sql`${stories.llmConfig} || ${JSON.stringify(set)}::jsonb`;
	for (const key of clear) {
		expression = sql`(${expression}) - ${key}::text`;
	}
	// Nothing else to write: arcs, enrich reads and chapter summaries are out of
	// date by their request fingerprints, and a mute or an unmute changes the
	// requests of exactly the ones that read this story.
	await db.update(stories).set({ llmConfig: expression }).where(eq(stories.id, storyId));
}
