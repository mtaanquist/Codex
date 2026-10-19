import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { s3Store, type BackupConfig } from '../../src/lib/server/backups';
import { makeS3Client } from '../../src/lib/server/s3-client';
import { checkoutId } from '../checkout-id';

// The backup store against a real S3-compatible server (RustFS in CI and in
// the dev compose file). The in-memory store in backups.test.ts never runs the
// SDK, and the SDK's multipart upload (anything over 5 MB) and its default
// checksums are where third-party servers differ from AWS.
// Set TEST_S3_ENDPOINT (plus TEST_S3_ACCESS_KEY_ID and TEST_S3_SECRET_ACCESS_KEY)
// to run it; CI always does.
const endpoint = process.env.TEST_S3_ENDPOINT;

const config: BackupConfig = {
	endpoint,
	region: process.env.TEST_S3_REGION || 'us-east-1',
	bucket: process.env.TEST_S3_BUCKET || 'codex-backups-test',
	prefix: `codex-backups-${checkoutId()}`,
	accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? '',
	secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? '',
	keepRecentHours: 48,
	keepDays: 30,
	cron: '0 * * * *'
};

function sha256(data: Buffer) {
	return createHash('sha256').update(data).digest('hex');
}

async function readAll(stream: Readable) {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

describe.skipIf(!endpoint && !process.env.CI)('s3Store against a real S3 server', () => {
	beforeAll(async () => {
		if (!endpoint) throw new Error('TEST_S3_ENDPOINT is not set (required in CI)');
		try {
			await makeS3Client(config).send(new CreateBucketCommand({ Bucket: config.bucket }));
		} catch (error) {
			const name = (error as { name?: string }).name;
			if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw error;
		}
	});

	it('uploads a multipart dump, lists it, reads it back intact, and removes it', async () => {
		const store = s3Store(config);
		// Over the SDK's 5 MB part size, so Upload goes multipart; random bytes
		// so nothing along the way can shrink it below that.
		const body = randomBytes(12 * 1024 * 1024);
		const key = `${config.prefix}/codex-2026-01-01T00-00-00-000Z.dump`;

		await store.put(key, Readable.from([body]));
		expect(await store.list()).toContain(key);

		const back = await readAll(await store.get(key));
		expect(back.length).toBe(body.length);
		expect(sha256(back)).toBe(sha256(body));

		await store.remove(key);
		expect(await store.list()).not.toContain(key);
	}, 60_000);
});
