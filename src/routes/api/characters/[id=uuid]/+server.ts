import type { RequestHandler } from './$types';
import { handleEntityPut } from '$lib/server/entity-put';

// Debounced autosave target for the character editor; the shared
// handler parses, saves, and queues the mention reindex.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	return await handleEntityPut('character', params.id, request, locals.user!.id);
};
