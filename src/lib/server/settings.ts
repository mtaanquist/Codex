import { eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { appSettings } from './db/schema.ts';
import { decryptSecret, encryptSecret, secretsAvailable } from './crypto.ts';

const SMTP_KEY = 'smtp';
const SIGNUP_KEY = 'signup';

// Generic accessors for one app_settings row; the callers shape the value.
export async function readSetting<T>(db: Database, key: string): Promise<T | null> {
	const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
	return row ? (row.value as T) : null;
}

export async function writeSetting(db: Database, key: string, value: unknown): Promise<void> {
	await db
		.insert(appSettings)
		.values({ key, value })
		.onConflictDoUpdate({
			target: appSettings.key,
			set: { value, updatedAt: sql`now()` }
		});
}

export async function clearSetting(db: Database, key: string): Promise<void> {
	await db.delete(appSettings).where(eq(appSettings.key, key));
}

// ============ S3 storage settings (backups and assets) ============
// Same resolution as SMTP: a saved row wins, the environment is the seed,
// and the secret key is stored encrypted.

export type StoredS3 = {
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKeyEnc: string | null;
};

// What the admin panel shows: never the secret itself.
export type S3SettingsView = {
	source: 'database' | 'environment' | 'none';
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	hasSecret: boolean;
};

export type SaveS3Result = { ok: true } | { ok: false; reason: string };

export type SaveS3Input = {
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
};

// Validates and stores one S3 connection under the given key. A blank secret
// keeps the stored one, like the SMTP password. Extra fields (retention
// numbers, say) ride along in the same row.
export async function saveS3Settings(
	db: Database,
	key: string,
	input: SaveS3Input,
	defaultPrefix: string,
	extra: Record<string, unknown> = {}
): Promise<SaveS3Result> {
	if (!input.bucket.trim()) return { ok: false, reason: 'Enter the bucket name.' };
	if (!input.accessKeyId.trim()) return { ok: false, reason: 'Enter the access key id.' };

	const existing = await readSetting<StoredS3>(db, key);
	let secretAccessKeyEnc = existing?.secretAccessKeyEnc ?? null;
	if (input.secretAccessKey) {
		if (!secretsAvailable()) {
			return { ok: false, reason: 'Set APP_SECRET on the server before storing a secret here.' };
		}
		secretAccessKeyEnc = encryptSecret(input.secretAccessKey);
	}
	if (!secretAccessKeyEnc) return { ok: false, reason: 'Enter the secret access key.' };

	const value: StoredS3 & Record<string, unknown> = {
		...extra,
		endpoint: input.endpoint.trim(),
		region: input.region.trim() || 'auto',
		bucket: input.bucket.trim(),
		prefix: (input.prefix.trim() || defaultPrefix).replace(/\/+$/, ''),
		accessKeyId: input.accessKeyId.trim(),
		secretAccessKeyEnc
	};
	await writeSetting(db, key, value);
	return { ok: true };
}

// The stored connection with its secret decrypted, for building a client.
export async function effectiveS3(
	db: Database,
	key: string
): Promise<(StoredS3 & { secretAccessKey: string }) | null> {
	const stored = await readSetting<StoredS3>(db, key);
	if (!stored) return null;
	return {
		...stored,
		secretAccessKey: stored.secretAccessKeyEnc ? decryptSecret(stored.secretAccessKeyEnc) : ''
	};
}

export async function s3SettingsView(
	db: Database,
	key: string,
	env: {
		endpoint: string | undefined;
		region: string;
		bucket: string;
		prefix: string;
		accessKeyId: string;
	} | null
): Promise<S3SettingsView> {
	const stored = await readSetting<StoredS3>(db, key);
	if (stored) {
		return {
			source: 'database',
			endpoint: stored.endpoint,
			region: stored.region,
			bucket: stored.bucket,
			prefix: stored.prefix,
			accessKeyId: stored.accessKeyId,
			hasSecret: Boolean(stored.secretAccessKeyEnc)
		};
	}
	if (env) {
		return {
			source: 'environment',
			endpoint: env.endpoint ?? '',
			region: env.region,
			bucket: env.bucket,
			prefix: env.prefix,
			accessKeyId: env.accessKeyId,
			hasSecret: true
		};
	}
	return {
		source: 'none',
		endpoint: '',
		region: '',
		bucket: '',
		prefix: '',
		accessKeyId: '',
		hasSecret: false
	};
}

// Who can create an account. 'approval' matches the behavior from before the
// setting existed, so an instance that has never saved one keeps working the
// same way.
export const SIGNUP_MODES = ['none', 'invite', 'approval', 'open'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

export async function signupMode(db: Database): Promise<SignupMode> {
	const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SIGNUP_KEY));
	const mode = (row?.value as { mode?: string } | undefined)?.mode;
	return SIGNUP_MODES.includes(mode as SignupMode) ? (mode as SignupMode) : 'approval';
}

export async function saveSignupMode(db: Database, mode: SignupMode): Promise<void> {
	await writeSetting(db, SIGNUP_KEY, { mode });
}

// What the worker needs to actually send: the password is decrypted here.
export type SmtpConfig = {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	password: string;
	from: string;
};

// Stored shape in app_settings.value; the password is kept encrypted.
type StoredSmtp = {
	host: string;
	port: number;
	secure: boolean;
	user: string;
	from: string;
	passwordEnc: string | null;
};

// What the admin panel shows: never the password itself, only whether one is
// set and where the effective config comes from.
export type SmtpView = {
	source: 'database' | 'environment' | 'none';
	host: string;
	port: number;
	secure: boolean;
	user: string;
	from: string;
	hasPassword: boolean;
};

function fromEnv(): StoredSmtp | null {
	const host = process.env.SMTP_HOST;
	if (!host) return null;
	return {
		host,
		port: Number(process.env.SMTP_PORT ?? 587),
		secure: process.env.SMTP_SECURE === 'true',
		user: process.env.SMTP_USER ?? '',
		from: process.env.SMTP_FROM ?? 'Codex <no-reply@localhost>',
		// The env password is plaintext from the operator's environment; mark it
		// so resolution below uses it directly rather than trying to decrypt.
		passwordEnc: null
	};
}

async function storedSmtp(db: Database): Promise<StoredSmtp | null> {
	const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SMTP_KEY));
	return row ? (row.value as StoredSmtp) : null;
}

// The effective config, with the password decrypted, for the worker to send
// with. Database settings win over environment; environment is the seed.
export async function effectiveSmtp(db: Database): Promise<SmtpConfig | null> {
	const stored = await storedSmtp(db);
	if (stored) {
		const password = stored.passwordEnc ? decryptSecret(stored.passwordEnc) : '';
		return { ...stored, password };
	}
	const env = fromEnv();
	if (env) return { ...env, password: process.env.SMTP_PASSWORD ?? '' };
	return null;
}

export async function smtpView(db: Database): Promise<SmtpView> {
	const stored = await storedSmtp(db);
	if (stored) {
		return {
			source: 'database',
			...stripPassword(stored),
			hasPassword: Boolean(stored.passwordEnc)
		};
	}
	const env = fromEnv();
	if (env) {
		return {
			source: 'environment',
			...stripPassword(env),
			hasPassword: Boolean(process.env.SMTP_PASSWORD)
		};
	}
	return {
		source: 'none',
		host: '',
		port: 587,
		secure: false,
		user: '',
		from: '',
		hasPassword: false
	};
}

function stripPassword(s: StoredSmtp) {
	return { host: s.host, port: s.port, secure: s.secure, user: s.user, from: s.from };
}

export type SaveSmtpResult = { ok: true } | { ok: false; reason: string };

// Saves the SMTP settings. A blank password leaves the stored one in place, so
// the admin can edit other fields without re-entering it. A new password is
// encrypted before storage and so requires APP_SECRET to be set.
export async function saveSmtp(
	db: Database,
	input: {
		host: string;
		port: number;
		secure: boolean;
		user: string;
		from: string;
		password: string;
	}
): Promise<SaveSmtpResult> {
	if (!input.host.trim()) return { ok: false, reason: 'Enter the SMTP host.' };
	if (!Number.isFinite(input.port) || input.port <= 0) {
		return { ok: false, reason: 'Enter a valid port.' };
	}

	const existing = await storedSmtp(db);
	let passwordEnc = existing?.passwordEnc ?? null;
	if (input.password) {
		if (!secretsAvailable()) {
			return { ok: false, reason: 'Set APP_SECRET on the server before storing a password here.' };
		}
		passwordEnc = encryptSecret(input.password);
	}

	const value: StoredSmtp = {
		host: input.host.trim(),
		port: input.port,
		secure: input.secure,
		user: input.user.trim(),
		from: input.from.trim() || 'Codex <no-reply@localhost>',
		passwordEnc
	};
	await writeSetting(db, SMTP_KEY, value);
	return { ok: true };
}
