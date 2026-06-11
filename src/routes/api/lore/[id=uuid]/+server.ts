import type { RequestHandler } from './$types';
import { handleEntityPut } from '$lib/server/entity-put';

// Debounced autosave target for the lore entry editor; the shared
// handler parses, saves, and queues the mention reindex.
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	return await handleEntityPut('lore', params.id, request, locals.user!.id);
};
