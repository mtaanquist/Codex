import { spawn } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { desc, eq } from 'drizzle-orm';
import {
	DeleteObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	S3Client
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Database } from './auth';
import { backupRuns } from './db/schema.ts';

// Off-site database backups to any S3-compatible bucket (S3, Backblaze B2,
// MinIO, R2). Configured entirely through environment variables and off
// until the bucket and keys are set. The worker runs the scheduled and
// ad-hoc jobs; backup_runs holds the evidence either way.

export type BackupConfig = {
	endpoint: string | undefined;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
	// How many dumps to keep in the bucket; older ones are pruned.
	keep: number;
	cron: string;
};

export function backupConfig(env: Record<string, string | undefined> = process.env) {
	const bucket = env.BACKUP_S3_BUCKET;
	const accessKeyId = env.BACKUP_S3_ACCESS_KEY_ID;
	const secretAccessKey = env.BACKUP_S3_SECRET_ACCESS_KEY;
	if (!bucket || !accessKeyId || !secretAccessKey) return null;
	const keep = Number.parseInt(env.BACKUP_KEEP ?? '', 10);
	return {
		endpoint: env.BACKUP_S3_ENDPOINT || undefined,
		region: env.BACKUP_S3_REGION || 'auto',
		bucket,
		prefix: (env.BACKUP_S3_PREFIX || 'codex-backups').replace(/\/+$/, ''),
		accessKeyId,
		secretAccessKey,
		keep: Number.isFinite(keep) && keep > 0 ? keep : 30,
		cron: env.BACKUP_CRON || '0 3 * * *'
	} satisfies BackupConfig;
}

// Timestamped keys sort lexically in age order, which both pruning and
// "restore latest" rely on.
export function backupKey(prefix: string, when: Date) {
	const stamp = when.toISOString().replace(/[:.]/g, '-');
	return `${prefix}/codex-${stamp}.dump`;
}

// The keys to delete once the newest `keep` are set aside.
export function selectPrunable(keys: string[], keep: number): string[] {
	return [...keys].sort().reverse().slice(Math.max(1, keep));
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
	const client = new S3Client({
		endpoint: config.endpoint,
		region: config.region,
		// B2 and MinIO want path-style addressing.
		forcePathStyle: Boolean(config.endpoint),
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey
		}
	});
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
	now?: Date;
};

// One full backup: dump, upload, record, prune. Failures are recorded too;
// a backup nobody can see failing is worse than none.
export async function runBackup(
	db: Database,
	trigger: 'scheduled' | 'manual',
	options: BackupRunOptions = {}
): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
	const config = options.config !== undefined ? options.config : backupConfig();
	if (!config) return { ok: false, reason: 'backups are not configured' };
	const store = options.store ?? s3Store(config);
	const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
	if (!databaseUrl) return { ok: false, reason: 'DATABASE_URL is not set' };

	const [run] = await db
		.insert(backupRuns)
		.values({ trigger, status: 'running' })
		.returning({ id: backupRuns.id });

	const key = backupKey(config.prefix, options.now ?? new Date());
	try {
		const [cmd, ...args] = options.dumpCommand ?? [
			'pg_dump',
			'--format=custom',
			// Queue state is transient and pg-boss recreates its schema on
			// start; its partitioned tables also break pg_restore --clean.
			'--exclude-schema=pgboss',
			'--dbname',
			databaseUrl
		];
		const dump = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		// Listen for the exit before any awaiting, or a fast dump's close
		// event fires while the upload is in flight and is never seen.
		const exited = exitCode(dump);
		let stderr = '';
		dump.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

		// Count bytes on the way through so the run can record the size.
		let sizeBytes = 0;
		const counted = new PassThrough();
		dump.stdout?.on('data', (chunk: Buffer) => (sizeBytes += chunk.length));
		dump.stdout?.pipe(counted);

		await store.put(key, counted);
		const code = await exited;
		if (code !== 0) {
			// The upload finished on a truncated stream; do not leave the
			// bad object looking like a usable backup.
			await store.remove(key).catch(() => {});
			throw new Error(`${cmd} exited with ${code}: ${stderr.slice(0, 500)}`);
		}

		await db
			.update(backupRuns)
			.set({ status: 'ok', objectKey: key, sizeBytes, finishedAt: new Date() })
			.where(eq(backupRuns.id, run.id));

		// Prune beyond the retention count; the run that just landed counts.
		const keys = await store.list();
		for (const old of selectPrunable(keys, config.keep)) {
			await store.remove(old);
		}
		return { ok: true, key };
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
	}
}

export async function listRecentBackupRuns(db: Database, limit = 10) {
	return await db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(limit);
}
