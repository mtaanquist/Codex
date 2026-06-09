import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { desc, eq, inArray, isNotNull, and } from 'drizzle-orm';
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Database } from './auth';
import { backupRuns } from './db/schema.ts';
import { makeS3Client } from './s3-client.ts';
import {
	effectiveS3,
	readSetting,
	s3SettingsView,
	saveS3Settings,
	type S3SettingsView,
	type SaveS3Input,
	type SaveS3Result,
	type StoredS3
} from './settings.ts';

// Off-site database backups to any S3-compatible bucket (S3, Backblaze B2,
// MinIO, R2). Off until the bucket and keys are set, in the admin panel or
// through the BACKUP_S3_* environment variables; settings saved in the panel
// win, the environment is the seed. The worker runs the scheduled and
// ad-hoc jobs; backup_runs holds the evidence either way.

export type BackupConfig = {
	endpoint: string | undefined;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
	// Tiered retention: every dump inside the recent window survives, then
	// the newest per UTC day out to keepDays. Frequency and depth stay
	// independently tunable that way.
	keepRecentHours: number;
	keepDays: number;
	cron: string;
};

function positiveInt(value: string | undefined, fallback: number) {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function backupConfig(env: Record<string, string | undefined> = process.env) {
	const bucket = env.BACKUP_S3_BUCKET;
	const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID;
	const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY;
	if (!bucket || !accessKeyId || !secretAccessKey) return null;
	return {
		endpoint: env.BACKUP_S3_ENDPOINT || undefined,
		region: env.BACKUP_S3_REGION || 'auto',
		bucket,
		prefix: (env.BACKUP_S3_PREFIX || 'codex-backups').replace(/\/+$/, ''),
		accessKeyId,
		secretAccessKey,
		keepRecentHours: positiveInt(env.BACKUP_KEEP_RECENT_HOURS, 48),
		keepDays: positiveInt(env.BACKUP_KEEP_DAYS, 30),
		// Hourly: a day of lost prose is the failure mode this exists to
		// prevent, and unchanged hours skip the upload anyway.
		cron: env.BACKUP_CRON || '0 * * * *'
	} satisfies BackupConfig;
}

const BACKUPS_KEY = 'backup-storage';
const BACKUP_PREFIX_DEFAULT = 'codex-backups';

type StoredBackups = StoredS3 & { keepRecentHours: number; keepDays: number };

// The effective backup config: settings saved in the admin panel win, the
// environment is the fallback. The cadence stays an operator concern, so
// BACKUP_CRON applies either way.
export async function effectiveBackupConfig(db: Database): Promise<BackupConfig | null> {
	const stored = await effectiveS3(db, BACKUPS_KEY);
	if (stored) {
		const extras = (await readSetting<StoredBackups>(db, BACKUPS_KEY))!;
		return {
			endpoint: stored.endpoint || undefined,
			region: stored.region || 'auto',
			bucket: stored.bucket,
			prefix: stored.prefix,
			accessKeyId: stored.accessKeyId,
			secretAccessKey: stored.secretAccessKey,
			keepRecentHours: positiveInt(String(extras.keepRecentHours ?? ''), 48),
			keepDays: positiveInt(String(extras.keepDays ?? ''), 30),
			cron: process.env.BACKUP_CRON || '0 * * * *'
		};
	}
	return backupConfig();
}

export async function backupStorageView(
	db: Database
): Promise<S3SettingsView & { keepRecentHours: number; keepDays: number }> {
	const view = await s3SettingsView(db, BACKUPS_KEY, backupConfig());
	if (view.source === 'database') {
		const extras = (await readSetting<StoredBackups>(db, BACKUPS_KEY))!;
		return {
			...view,
			keepRecentHours: positiveInt(String(extras.keepRecentHours ?? ''), 48),
			keepDays: positiveInt(String(extras.keepDays ?? ''), 30)
		};
	}
	const env = backupConfig();
	return {
		...view,
		keepRecentHours: env?.keepRecentHours ?? 48,
		keepDays: env?.keepDays ?? 30
	};
}

export async function saveBackupStorage(
	db: Database,
	input: SaveS3Input & { keepRecentHours: number; keepDays: number }
): Promise<SaveS3Result> {
	if (!Number.isInteger(input.keepRecentHours) || input.keepRecentHours < 1) {
		return { ok: false, reason: 'Keep every dump for at least one hour.' };
	}
	if (!Number.isInteger(input.keepDays) || input.keepDays < 1) {
		return { ok: false, reason: 'Keep daily dumps for at least one day.' };
	}
	return saveS3Settings(db, BACKUPS_KEY, input, BACKUP_PREFIX_DEFAULT, {
		keepRecentHours: input.keepRecentHours,
		keepDays: input.keepDays
	});
}

// Timestamped keys sort lexically in age order, which both pruning and
// "restore latest" rely on.
export function backupKey(prefix: string, when: Date) {
	const stamp = when.toISOString().replace(/[:.]/g, '-');
	return `${prefix}/codex-${stamp}.dump`;
}

// The moment a key was written, recovered from its name; null for keys
// this code did not produce.
export function backupKeyTime(key: string): Date | null {
	const match = /codex-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.dump$/.exec(key);
	if (!match) return null;
	const [, day, hh, mm, ss, ms] = match;
	const date = new Date(`${day}T${hh}:${mm}:${ss}.${ms}Z`);
	return Number.isNaN(date.getTime()) ? null : date;
}

// The newest real backup under the prefix. Only keys this code wrote count:
// a leftover connection-probe object (s3-client.ts) sorts after the codex-*
// keys and would otherwise be picked as "latest", then fail pg_restore on
// bytes that are not an archive.
export function latestBackupKey(keys: string[]): string | null {
	let best: { key: string; time: number } | null = null;
	for (const key of keys) {
		const time = backupKeyTime(key)?.getTime();
		if (time === undefined) continue;
		if (!best || time > best.time) best = { key, time };
	}
	return best?.key ?? null;
}

// Tiered pruning: keep everything from the recent window, the newest per
// UTC day out to keepDays, and anything whose name cannot be parsed
// (never delete what is not understood).
export function selectPrunable(
	keys: string[],
	now: Date,
	keepRecentHours: number,
	keepDays: number
): string[] {
	const recentCutoff = now.getTime() - keepRecentHours * 3_600_000;
	const dailyCutoff = now.getTime() - keepDays * 86_400_000;
	const keep = new Set<string>();
	const byDay = new Map<string, { key: string; time: number }>();
	for (const key of keys) {
		const time = backupKeyTime(key)?.getTime();
		if (time === undefined) {
			keep.add(key);
			continue;
		}
		if (time >= recentCutoff) {
			keep.add(key);
			continue;
		}
		if (time < dailyCutoff) continue;
		const day = new Date(time).toISOString().slice(0, 10);
		const best = byDay.get(day);
		if (!best || time > best.time) byDay.set(day, { key, time });
	}
	for (const { key } of byDay.values()) keep.add(key);
	return keys.filter((key) => !keep.has(key));
}

// The bucket operations the backup job needs, small enough to fake in
// tests; s3Store is the real one.
export type BackupStore = {
	put(key: string, body: Readable): Promise<void>;
	list(): Promise<string[]>;
	remove(key: string): Promise<void>;
	get(key: string): Promise<Readable>;
};

export function s3Store(config: BackupConfig): BackupStore {
	const client = makeS3Client(config);
	return {
		async put(key, body) {
			const upload = new Upload({
				client,
				params: { Bucket: config.bucket, Key: key, Body: body }
			});
			await upload.done();
		},
		async list() {
			const keys: string[] = [];
			let token: string | undefined;
			do {
				const page = await client.send(
					new ListObjectsV2Command({
						Bucket: config.bucket,
						Prefix: `${config.prefix}/`,
						ContinuationToken: token
					})
				);
				for (const object of page.Contents ?? []) {
					if (object.Key) keys.push(object.Key);
				}
				token = page.IsTruncated ? page.NextContinuationToken : undefined;
			} while (token);
			return keys;
		},
		async remove(key) {
			await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
		},
		async get(key) {
			const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
			if (!object.Body) throw new Error(`empty object: ${key}`);
			return object.Body as Readable;
		}
	};
}

function exitCode(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => resolve(code ?? 1));
	});
}

export type BackupRunOptions = {
	config?: BackupConfig | null;
	store?: BackupStore;
	databaseUrl?: string;
	// The dump command, injectable for tests; production uses pg_dump.
	dumpCommand?: string[];
	// How the unchanged-since-last-run hash is derived from the scratch dump.
	// Injectable for tests; production renders the archive as plain SQL with
	// pg_restore (see hashDump).
	hashCommand?: (scratchPath: string) => string[];
	now?: Date;
};

// The custom-format archive embeds its creation timestamp in the header, so
// hashing the dump bytes makes two dumps of identical data differ every time
// and the skip never fires. pg_restore renders the archive back to plain SQL,
// which carries no timestamp, so identical data hashes identically.
function defaultHashCommand(scratchPath: string): string[] {
	// `-f -` writes the plain SQL to stdout (pg_restore requires one of -f/-d).
	return ['pg_restore', '--no-owner', '-f', '-', scratchPath];
}

async function hashDump(
	scratchPath: string,
	build: (scratchPath: string) => string[] = defaultHashCommand
): Promise<string> {
	const [cmd, ...args] = build(scratchPath);
	const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
	const exited = exitCode(child);
	let stderr = '';
	child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
	const hash = createHash('sha256');
	for await (const chunk of child.stdout!) hash.update(chunk as Buffer);
	const code = await exited;
	if (code !== 0) {
		throw new Error(`${cmd} (hash) exited with ${code}: ${stderr.slice(0, 500)}`);
	}
	return hash.digest('hex');
}

// One full backup: dump to a scratch file, skip the upload when nothing
// changed since the last run, otherwise upload and prune. Failures are
// recorded too; a backup nobody can see failing is worse than none.
export async function runBackup(
	db: Database,
	trigger: 'scheduled' | 'manual',
	options: BackupRunOptions = {}
): Promise<{ ok: true; key: string | null; skipped: boolean } | { ok: false; reason: string }> {
	const config = options.config !== undefined ? options.config : await effectiveBackupConfig(db);
	if (!config) return { ok: false, reason: 'backups are not configured' };
	const store = options.store ?? s3Store(config);
	const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
	if (!databaseUrl) return { ok: false, reason: 'DATABASE_URL is not set' };

	const [run] = await db
		.insert(backupRuns)
		.values({ trigger, status: 'running' })
		.returning({ id: backupRuns.id });

	const now = options.now ?? new Date();
	const scratch = join(tmpdir(), `codex-backup-${run.id}.dump`);
	try {
		const [cmd, ...args] = options.dumpCommand ?? [
			'pg_dump',
			'--format=custom',
			// Queue state is transient and pg-boss recreates its schema on
			// start; its partitioned tables also break pg_restore --clean.
			'--exclude-schema=pgboss',
			// This run writes a backup_runs row before dumping, so including the
			// table would make every dump differ from the last and defeat the
			// unchanged-hour skip. It is operational evidence, not user data.
			'--exclude-table=backup_runs',
			'--dbname',
			databaseUrl
		];
		const dump = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		// Listen for the exit before any awaiting, or a fast dump's close
		// event fires while the file write is in flight and is never seen.
		const exited = exitCode(dump);
		let stderr = '';
		dump.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

		// To a scratch file first: nothing reaches the bucket until the dump
		// is known whole, and the hash decides whether it needs to at all.
		await pipeline(dump.stdout!, createWriteStream(scratch));
		const code = await exited;
		if (code !== 0) {
			throw new Error(`${cmd} exited with ${code}: ${stderr.slice(0, 500)}`);
		}
		const sizeBytes = (await stat(scratch)).size;
		// Hash a deterministic rendering of the dump, not its raw bytes, so the
		// unchanged-hour skip below actually fires (see hashDump).
		const contentHash = await hashDump(scratch, options.hashCommand);

		// Same bytes as the last run: record the cadence, upload nothing.
		const [previous] = await db
			.select({ contentHash: backupRuns.contentHash })
			.from(backupRuns)
			.where(and(inArray(backupRuns.status, ['ok', 'skipped']), isNotNull(backupRuns.contentHash)))
			.orderBy(desc(backupRuns.startedAt))
			.limit(1);
		if (previous?.contentHash === contentHash) {
			await db
				.update(backupRuns)
				.set({ status: 'skipped', sizeBytes, contentHash, finishedAt: new Date() })
				.where(eq(backupRuns.id, run.id));
			return { ok: true, key: null, skipped: true };
		}

		const key = backupKey(config.prefix, now);
		await store.put(key, createReadStream(scratch));
		await db
			.update(backupRuns)
			.set({ status: 'ok', objectKey: key, sizeBytes, contentHash, finishedAt: new Date() })
			.where(eq(backupRuns.id, run.id));

		// Tiered pruning; the dump that just landed is inside the recent
		// window by definition.
		const keys = await store.list();
		for (const old of selectPrunable(keys, now, config.keepRecentHours, config.keepDays)) {
			await store.remove(old);
		}
		return { ok: true, key, skipped: false };
	} catch (error) {
		await db
			.update(backupRuns)
			.set({
				status: 'failed',
				error: error instanceof Error ? error.message : String(error),
				finishedAt: new Date()
			})
			.where(eq(backupRuns.id, run.id));
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	} finally {
		await rm(scratch, { force: true });
	}
}

export async function listRecentBackupRuns(db: Database, limit = 10) {
	return await db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(limit);
}
