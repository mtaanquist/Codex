// Production entry for the app; scripts/start-app.sh runs it. adapter-node 6
// takes the site origin from the build, but one image serves every install, so
// the origin has to come from ORIGIN at runtime. Every request gets ORIGIN's
// protocol and host in two private headers (overwriting anything a client
// sent), and adapter-node is told to read its origin from them.
import process from 'node:process';

export const PROTOCOL_HEADER = 'x-codex-origin-proto';
export const HOST_HEADER = 'x-codex-origin-host';

/** @param {string | undefined} origin */
export function originParts(origin) {
	if (!origin) {
		throw new Error('ORIGIN is not set. Set it to the public URL the app is reached on.');
	}
	const url = new URL(origin);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`ORIGIN must start with http:// or https://, not ${url.protocol}`);
	}
	return { protocol: url.protocol.slice(0, -1), host: url.host };
}

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {{ protocol: string, host: string }} parts
 */
export function setOriginHeaders(headers, { protocol, host }) {
	headers[PROTOCOL_HEADER] = protocol;
	headers[HOST_HEADER] = host;
}

if (import.meta.main) {
	const parts = originParts(process.env.ORIGIN);
	// Read by adapter-node when its handler loads, so set before the import.
	// The port is part of ORIGIN's host, so no port header.
	process.env.PROTOCOL_HEADER = PROTOCOL_HEADER;
	process.env.HOST_HEADER = HOST_HEADER;
	process.env.PORT_HEADER = '';
	// A computed specifier, so type checking does not walk into the build output.
	const entry = './build/index.js';
	/** @type {{ server: import('node:http').Server }} */
	const { server } = await import(entry);
	// Runs before adapter-node's own request listener.
	server.prependListener('request', (req) => setOriginHeaders(req.headers, parts));
}
