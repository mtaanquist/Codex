import type { Database } from '../auth.ts';
import {
	ASSISTANT_ROLES,
	accountLlmConfig,
	layerModels,
	scopeModels,
	type AssistantRole,
	type ModelMap
} from './config.ts';
import { suggestedModel } from './providers/model-guide.ts';

// What the model pickers on a universe's or a story's settings page show.
export type ScopeModelSettings = {
	// The models chosen at this level.
	saved: ModelMap;
	// The models chosen above it: the account's for a universe, the account's
	// with the universe's laid over them for a story.
	inherited: ModelMap;
	// What a role runs on when nothing is chosen for it anywhere.
	suggested: Record<AssistantRole, string>;
};

export async function scopeModelSettings(
	db: Database,
	userId: string,
	scope: { storyId: string } | { universeId: string }
): Promise<ScopeModelSettings> {
	const [account, chosen] = await Promise.all([
		accountLlmConfig(db, userId),
		scopeModels(db, userId, scope)
	]);
	const forStory = 'storyId' in scope;
	return {
		saved: forStory ? chosen.story : chosen.universe,
		inherited: forStory ? layerModels(account.models, chosen.universe, {}) : account.models,
		suggested: Object.fromEntries(
			ASSISTANT_ROLES.map((role) => [role, suggestedModel(account.provider, role)])
		) as Record<AssistantRole, string>
	};
}

// The picks a settings form posted: one field per role, blank for "use the
// default". A model id is free text, so it is only trimmed and capped.
export function modelsFromForm(data: FormData): ModelMap {
	const models: ModelMap = {};
	for (const role of ASSISTANT_ROLES) {
		const value = data.get(role);
		if (typeof value === 'string' && value.trim()) models[role] = value.trim().slice(0, 200);
	}
	return models;
}
