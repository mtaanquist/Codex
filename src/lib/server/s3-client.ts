import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

// One way to build an S3-compatible client, shared by backups and assets.
// The buckets differ; the connection shape does not.
export type S3Connection = {
	endpoint: string | undefined;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
};

export function makeS3Client(connection: S3Connection) {
	return new S3Client({
		endpoint: connection.endpoint,
		region: connection.region,
		// B2 and RustFS want path-style addressing.
		forcePathStyle: Boolean(connection.endpoint),
		// Some S3-compatible services reject the SDK's default checksums.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
		credentials: {
			accessKeyId: connection.accessKeyId,
			secretAccessKey: connection.secretAccessKey
		},
		// Without these a hung endpoint holds the caller forever. The socket
		// timeout is an idle limit, so a large transfer that keeps moving is
		// never cut off.
		requestHandler: {
			connectionTimeout: 5_000,
			socketTimeout: 30_000
		}
	});
}

// One client (and its keep-alive pool) per connection, so request handlers
// reuse sockets instead of opening a fresh client for every image. A changed
// setting yields a new key; the few stale entries are not worth evicting.
const shared = new Map<string, S3Client>();

export function sharedS3Client(connection: S3Connection): S3Client {
	const key = JSON.stringify([
		connection.endpoint ?? '',
		connection.region,
		connection.accessKeyId,
		connection.secretAccessKey
	]);
	let client = shared.get(key);
	if (!client) {
		client = makeS3Client(connection);
		shared.set(key, client);
	}
	return client;
}

// True for a GetObject on a key that does not exist. S3-compatible services
// do not all name the error the same, so the HTTP status is checked too.
export function isMissingObject(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
	return name === 'NoSuchKey' || name === 'NotFound' || $metadata?.httpStatusCode === 404;
}

// Writes and removes a tiny probe object, proving the endpoint, bucket,
// credentials, and write permission in one round trip. Used by the admin
// panel's "test connection" buttons.
export async function probeS3(
	connection: S3Connection & { bucket: string; prefix: string }
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const client = makeS3Client(connection);
	const key = `${connection.prefix}/connection-probe`;
	try {
		await client.send(
			new PutObjectCommand({
				Bucket: connection.bucket,
				Key: key,
				Body: 'codex connection probe',
				ContentType: 'text/plain'
			})
		);
		await client.send(new DeleteObjectCommand({ Bucket: connection.bucket, Key: key }));
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
