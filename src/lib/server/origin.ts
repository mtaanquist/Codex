import { building, dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { resolveOrigin } from './origin-rule';

// Only the dev server falls back to the request origin.
export function publicOrigin(url: URL): string {
	return resolveOrigin(env.ORIGIN, url.origin, dev);
}

// Called once at server start so a missing ORIGIN stops the app there,
// rather than on the first emailed link.
export function assertOriginConfigured(): void {
	if (dev || building) return;
	resolveOrigin(env.ORIGIN, '', false);
}
