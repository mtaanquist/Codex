import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { makeS3Client, sharedS3Client, type S3Connection } from './s3-client';
import { ObjectNotFoundError, getObjectOrNull, s3AssetStore } from './assets';

const connection: S3Connection = {
	endpoint: 'http://127.0.0.1:1',
	region: 'us-east-1',
	accessKeyId: 'id',
	secretAccessKey: 'secret'
};

describe('sharedS3Client', () => {
	it('reuses one client per connection and builds a new one when it changes', () => {
		const first = sharedS3Client(connection);
		expect(sharedS3Client({ ...connection })).toBe(first);
		expect(sharedS3Client({ ...connection, secretAccessKey: 'rotated' })).not.toBe(first);
		expect(sharedS3Client({ ...connection, endpoint: 'http://127.0.0.1:2' })).not.toBe(first);
	});
});

describe('makeS3Client', () => {
	it('sets connection and idle timeouts on the request handler', async () => {
		const handler = makeS3Client(connection).config.requestHandler as unknown as {
			handle(request: unknown): Promise<unknown>;
			httpHandlerConfigs(): { connectionTimeout?: number; socketTimeout?: number };
		};
		// The handler resolves its options on first use; a request to a closed
		// port is enough to load them.
		await handler
			.handle({
				protocol: 'http:',
				hostname: '127.0.0.1',
				port: 1,
				path: '/',
				method: 'GET',
				headers: {}
			})
			.catch(() => {});
		expect(handler.httpHandlerConfigs()).toMatchObject({
			connectionTimeout: 5_000,
			socketTimeout: 30_000
		});
	});
});

// A stand-in S3 endpoint that answers every request with a fixed error.
let server: Server;
let status = 404;
let code = 'NoSuchKey';

beforeAll(async () => {
	server = createServer((_req, res) => {
		res.writeHead(status, { 'content-type': 'application/xml' });
		res.end(
			`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>x</Message></Error>`
		);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

function store() {
	const { port } = server.address() as AddressInfo;
	return s3AssetStore({
		...connection,
		endpoint: `http://127.0.0.1:${port}`,
		bucket: 'b',
		prefix: 'p'
	});
}

describe('s3AssetStore.get', () => {
	it('reports a missing object as ObjectNotFoundError, which getObjectOrNull turns into null', async () => {
		status = 404;
		code = 'NoSuchKey';
		await expect(store().get('p/gone')).rejects.toBeInstanceOf(ObjectNotFoundError);
		expect(await getObjectOrNull(store(), 'p/gone')).toBeNull();
	});

	it('passes other failures through unchanged', async () => {
		status = 403;
		code = 'AccessDenied';
		await expect(getObjectOrNull(store(), 'p/key')).rejects.toMatchObject({
			name: 'AccessDenied'
		});
	});
});
