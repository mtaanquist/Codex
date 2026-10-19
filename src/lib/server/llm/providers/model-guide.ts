import type { AssistantRole } from '../../../assistant-tuning.ts';
import type { ProviderId } from './presets.ts';

// Which model to suggest for each Assistant role, per provider. Pure data, safe
// to hand to the page load. The roles want one of three tiers; each provider
// says what that tier is on its catalogue. Refresh this table and the help
// article's "Which model to pick for each role" together when providers ship
// new models.

export type ModelTier = 'fast' | 'balanced' | 'strongest';

export const ROLE_TIER: Record<AssistantRole, ModelTier> = {
	chat: 'balanced',
	coauthor: 'balanced',
	continuation: 'fast',
	reviewer: 'strongest',
	utility: 'fast'
};

// `id` is set only where the model id is stable and verified, so it can be
// offered before discovery and used when a role has no model picked. Elsewhere
// `text` names the model family, since those catalogues rename ids often.
export type TierSuggestion = { id?: string; text: string };

export const MODEL_GUIDE: Record<ProviderId, Record<ModelTier, TierSuggestion>> = {
	anthropic: {
		fast: { id: 'claude-haiku-5-5', text: 'Claude Haiku 5.5' },
		balanced: { id: 'claude-sonnet-5-5', text: 'Claude Sonnet 5.5' },
		strongest: { id: 'claude-opus-5-5', text: 'Claude Opus 5.5' }
	},
	openai: {
		fast: { text: 'the newest Luna or mini model' },
		balanced: { text: 'the newest Sol model' },
		strongest: { text: 'the newest Astra model, or Sol if Astra is too slow' }
	},
	gemini: {
		fast: { text: 'the newest Flash-Lite model' },
		balanced: { text: 'the newest Flash model' },
		strongest: { text: 'the newest Pro model' }
	},
	deepseek: {
		fast: { text: 'deepseek-flash' },
		balanced: { text: 'deepseek-flash' },
		strongest: { text: 'the Pro model if your account lists one, otherwise deepseek-flash' }
	},
	openrouter: {
		fast: { text: 'a small fast model, such as Claude Haiku or Gemini Flash-Lite' },
		balanced: { text: 'a mid-sized model, such as Claude Sonnet or Gemini Flash' },
		strongest: { text: 'a top model, such as Claude Opus or Gemini Pro' }
	},
	custom: {
		fast: {
			text: 'a mixture-of-experts instruct model such as Qwen3 30B A3B (search for MoE instruct GGUF)'
		},
		balanced: {
			text: 'any instruct model you like reading; Qwen3 30B A3B is a good start'
		},
		strongest: {
			text: 'a dense 32B instruct model such as Qwen3 32B (search for 32B instruct GGUF)'
		}
	}
};

export function roleSuggestion(provider: ProviderId, role: AssistantRole): TierSuggestion {
	return MODEL_GUIDE[provider][ROLE_TIER[role]];
}

// The model id a role runs on when nothing is picked at all; empty where the
// provider has no verified id to fall back to.
export function suggestedModel(provider: ProviderId, role: AssistantRole): string {
	return roleSuggestion(provider, role).id ?? '';
}
