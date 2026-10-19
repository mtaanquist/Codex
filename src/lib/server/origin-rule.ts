// The app's public origin for links that leave the request, above all the
// ones mailed out. Outside development it must come from ORIGIN: without it,
// adapter-node derives the request URL from the Host header, so a forged
// Host would put an attacker's domain in a password-reset link. Kept free of
// SvelteKit imports so the plain-Node worker can use it too.
export function resolveOrigin(
	configured: string | undefined,
	fallback: string,
	allowFallback: boolean
): string {
	if (configured) return configured;
	if (allowFallback) return fallback;
	throw new Error('ORIGIN is not set. Set it to the public URL the app is reached on.');
}
