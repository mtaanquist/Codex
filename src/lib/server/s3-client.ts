import { S3Client } from '@aws-sdk/client-s3';

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
