import { adapterKind, type ProviderId } from './presets.ts';
import { anthropicProvider } from './anthropic.ts';
import { openaiProvider } from './openai.ts';
import type { Provider } from './types.ts';

// The one place a provider id becomes an adapter; the gateway and the setup
// helpers both pick through here.
export function providerFor(id: ProviderId): Provider {
	return adapterKind(id) === 'anthropic' ? anthropicProvider : openaiProvider;
}
