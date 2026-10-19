import { building, dev } from '$app/environment';
import { env } from '$env/dynamic/private';

// The app's public origin for links that leave the request, above all the
// ones mailed out. A built app must take it from ORIGIN: without it,
// adapter-node derives the request URL from the Host header, so a forged
// Host would put an attacker's domain in a password-reset link. Only the
// dev server falls back to the request origin.
export function resolveOrigin(
	configured: string | undefined,
	requestOrigin: string,
	allowRequestFallback: boolean
): string {
	if (configured) return configured;
	if (allowRequestFallback) return requestOrigin;
	throw new Error('ORIGIN is not set. Set it to the public URL the app is reached on.');
}

export function publicOrigin(url: URL): string {
	return resolveOrigin(env.ORIGIN, url.origin, dev);
}

// Called once at server start so a missing ORIGIN stops the app there,
// rather than on the first emailed link.
export function assertOriginConfigured(): void {
	if (dev || building) return;
	resolveOrigin(env.ORIGIN, '', false);
}
