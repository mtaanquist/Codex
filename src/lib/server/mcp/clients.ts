import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { oauthClients } from '../db/schema.ts';
import { egressHttpRequest } from '../llm/egress.ts';
import {
	CLIENT_DOCUMENT_MAX_BYTES,
	CLIENT_DOCUMENT_TIMEOUT_MS,
	CLIENT_DOCUMENT_TTL_MS
} from './constants.ts';
import {
	isClientIdUrl,
	isLoopbackRedirect,
	parseClientMetadata,
	redirectHost,
	type MetadataResult
} from './rules.ts';

// The apps that may ask for access. A client reaches this table one of two
// ways: it registers itself (dynamic client registration), or its client_id is
// the https address of a metadata document, which is fetched and cached here.

export type OauthClient = typeof oauthClients.$inferSelect;

export type RegisterResult =
	{ ok: true; client: OauthClient } | Exclude<MetadataResult, { ok: true }>;

export async function registerClient(db: Database, input: unknown): Promise<RegisterResult> {
	const parsed = parseClientMetadata(input);
	if (!parsed.ok) return parsed;
	const { clientName, redirectUris } = parsed.metadata;
	// A self-registered client proves nothing about who it is. What can be
	// vouched for is where the code will be sent. A client with a local
	// address is named by that one even when it lists a remote host too: any
	// program on this computer can list a remote address it does not control.
	const host = redirectHost(redirectUris.find(isLoopbackRedirect) ?? redirectUris[0]);
	const [client] = await db
		.insert(oauthClients)
		.values({
			clientId: randomUUID(),
			kind: 'dcr',
			clientName: clientName ?? host,
			host,
			redirectUris
		})
		.returning();
	return { ok: true, client };
}

// Fetches a client metadata document. Injected in tests.
export type FetchClientDocument = (url: string) => Promise<unknown>;

// The address comes from an unauthenticated request, so the fetch refuses
// private and local addresses whatever the instance's own egress setting is,
// follows no redirect, and gives up on a slow or oversized answer.
export const fetchClientDocument: FetchClientDocument = async (url) => {
	const request = egressHttpRequest(
		{ policy: 'block-private', allowlist: [] },
		CLIENT_DOCUMENT_TIMEOUT_MS
	);
	const response = await request(url, {
		method: 'GET',
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(CLIENT_DOCUMENT_TIMEOUT_MS)
	});
	if (response.status !== 200) throw new Error(`The client document answered ${response.status}.`);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > CLIENT_DOCUMENT_MAX_BYTES) throw new Error('The client document is too large.');
		chunks.push(Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

async function clientFromDocument(
	db: Database,
	clientId: string,
	cached: OauthClient | undefined,
	fetchDocument: FetchClientDocument
): Promise<OauthClient | null> {
	let doc: unknown;
	try {
		doc = await fetchDocument(clientId);
	} catch {
		// The document's host is down or slow. A copy already checked still
		// stands; an app never seen before cannot be let in on trust.
		return cached ?? null;
	}
	// The document must name the address it was fetched from, or anyone could
	// point at someone else's document.
	if ((doc as { client_id?: unknown } | null)?.client_id !== clientId) return null;
	const parsed = parseClientMetadata(doc);
	if (!parsed.ok) return null;
	const host = new URL(clientId).host;
	const values = {
		clientName: parsed.metadata.clientName ?? host,
		host,
		redirectUris: parsed.metadata.redirectUris,
		fetchedAt: sql`now()`
	};
	const [client] = await db
		.insert(oauthClients)
		.values({ clientId, kind: 'cimd', ...values })
		.onConflictDoUpdate({ target: oauthClients.clientId, set: values })
		.returning();
	return client;
}

// The client a client_id names, or null when there is none.
export async function findClient(
	db: Database,
	clientId: string,
	fetchDocument: FetchClientDocument = fetchClientDocument
): Promise<OauthClient | null> {
	if (!clientId) return null;
	const [stored] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
	if (!isClientIdUrl(clientId)) return stored?.kind === 'dcr' ? stored : null;
	if (stored && stored.kind !== 'cimd') return null;
	const fresh =
		stored?.fetchedAt && Date.now() - stored.fetchedAt.getTime() < CLIENT_DOCUMENT_TTL_MS;
	return fresh ? stored : clientFromDocument(db, clientId, stored, fetchDocument);
}

// A client already in the table, with no fetch: the token endpoint only ever
// sees clients the authorize step has already resolved.
export async function storedClient(db: Database, clientId: string): Promise<OauthClient | null> {
	if (!clientId) return null;
	const [stored] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
	return stored ?? null;
}
