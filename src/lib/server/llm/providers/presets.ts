// The provider presets the account settings page offers, plus the discriminator
// stored in the account config. 'custom' is the bring-your-own OpenAI-compatible
// endpoint the first cut shipped with, and the default for every config saved
// before the discriminator existed. Pure data, safe to hand to the page load;
// the adapters themselves are picked in ./index.ts.

export const PROVIDER_IDS = [
	'custom',
	'anthropic',
	'openai',
	'gemini',
	'deepseek',
	'openrouter'
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function normaliseProviderId(raw: unknown): ProviderId {
	return PROVIDER_IDS.includes(raw as ProviderId) ? (raw as ProviderId) : 'custom';
}

// Which wire format a provider speaks: everything but Anthropic rides the
// OpenAI-compatible adapter.
export type AdapterKind = 'openai-compatible' | 'anthropic';

export type ProviderPreset = {
	id: Exclude<ProviderId, 'custom'>;
	label: string;
	adapter: AdapterKind;
	// The endpoint stored when this preset is chosen; the form's URL field is
	// ignored for presets so a stale or tampered value cannot point elsewhere.
	baseUrl: string;
	// Placeholder for the API key field, hinting at the expected key shape.
	keyHint: string;
	// Where to create an API key.
	docsUrl: string;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		id: 'anthropic',
		label: 'Claude (Anthropic)',
		adapter: 'anthropic',
		baseUrl: 'https://api.anthropic.com',
		// Pro/Max subscriptions are not API credentials; only a console key works.
		keyHint: 'sk-ant-... (an API key from the console, not a Claude subscription)',
		docsUrl: 'https://console.anthropic.com/settings/keys'
	},
	{
		id: 'openai',
		label: 'ChatGPT (OpenAI)',
		adapter: 'openai-compatible',
		baseUrl: 'https://api.openai.com/v1',
		keyHint: 'sk-...',
		docsUrl: 'https://platform.openai.com/api-keys'
	},
	{
		id: 'gemini',
		label: 'Gemini (Google)',
		adapter: 'openai-compatible',
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
		keyHint: 'AIza...',
		docsUrl: 'https://aistudio.google.com/apikey'
	},
	{
		id: 'deepseek',
		label: 'DeepSeek',
		adapter: 'openai-compatible',
		baseUrl: 'https://api.deepseek.com/v1',
		keyHint: 'sk-...',
		docsUrl: 'https://platform.deepseek.com/api_keys'
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		adapter: 'openai-compatible',
		baseUrl: 'https://openrouter.ai/api/v1',
		keyHint: 'sk-or-...',
		docsUrl: 'https://openrouter.ai/keys'
	}
];

export function providerPreset(id: ProviderId): ProviderPreset | undefined {
	return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function adapterKind(id: ProviderId): AdapterKind {
	return providerPreset(id)?.adapter ?? 'openai-compatible';
}
