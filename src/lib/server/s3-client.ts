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
		// B2 and MinIO want path-style addressing.
		forcePathStyle: Boolean(connection.endpoint),
		credentials: {
			accessKeyId: connection.accessKeyId,
			secretAccessKey: connection.secretAccessKey
		}
	});
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
