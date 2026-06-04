import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';

// Symmetric encryption for secrets kept in the database - the SMTP password
// now, and the same helper is meant to serve LLM keys and TOTP secrets later.
// The key is derived from APP_SECRET, which must be set to store or read any
// encrypted secret. AES-256-GCM; the iv and auth tag travel with the value.

function key(): Buffer {
	const secret = process.env.APP_SECRET;
	if (!secret) {
		throw new Error('APP_SECRET is not set, so encrypted secrets cannot be read or written.');
	}
	return createHash('sha256').update(secret).digest();
}

// Whether an APP_SECRET is configured at all. The UI checks this before
// offering to store a secret, rather than failing on save.
export function secretsAvailable(): boolean {
	return Boolean(process.env.APP_SECRET);
}

export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

export function decryptSecret(packed: string): string {
	const [ivB64, tagB64, bodyB64] = packed.split(':');
	if (!ivB64 || !tagB64 || !bodyB64) throw new Error('Malformed encrypted value.');
	const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
	decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
	return Buffer.concat([
		decipher.update(Buffer.from(bodyB64, 'base64')),
		decipher.final()
	]).toString('utf8');
}

// A tamper-proof token: the payload travels in the clear with an HMAC over it,
// keyed by APP_SECRET. Use for short-lived state that the server issues and
// later trusts (the two-factor sign-in challenge), not for secrets. The payload
// must not contain the '.' separator.
export function signToken(payload: string): string {
	const sig = createHmac('sha256', key()).update(payload).digest('base64url');
	return `${payload}.${sig}`;
}

export function verifyToken(signed: string): string | null {
	const dot = signed.lastIndexOf('.');
	if (dot <= 0) return null;
	const payload = signed.slice(0, dot);
	const sig = signed.slice(dot + 1);
	const expected = createHmac('sha256', key()).update(payload).digest('base64url');
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	return payload;
}
