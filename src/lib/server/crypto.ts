import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

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
