import { adapterKind, type ProviderId } from './presets';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import type { Provider } from './types';

// The one place a provider id becomes an adapter; the gateway and the setup
// helpers both pick through here.
export function providerFor(id: ProviderId): Provider {
	return adapterKind(id) === 'anthropic' ? anthropicProvider : openaiProvider;
}
