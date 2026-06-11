import { error, json } from '@sveltejs/kit';
import { db } from './db';
import { throwActionError } from './action-result';
import { saveEntity, type EntitySaveKind } from './entity-save.ts';
import { queueUniverseMentions } from './jobs';
import { rateLimitWrites } from './write-guard';
import { checkProseLength, readJson } from './validation';
import { cleanDetails } from '$lib/entity-snapshot';

// The shared body of the character/place/lore PUT autosave endpoints: parse
// and validate the payload, save through the one entity flow, and queue the
// mention reindex when the name or tags changed.
export async function handleEntityPut(
	kind: EntitySaveKind,
	entityId: string,
	request: Request,
	userId: string
): Promise<Response> {
	rateLimitWrites(userId);
	const payload = await readJson<{
		name?: unknown;
		aliases?: unknown;
		keywords?: unknown;
		summaryMd?: unknown;
		bodyMd?: unknown;
		details?: unknown;
		categoryId?: unknown;
		storyId?: unknown;
		storyNotesMd?: unknown;
	}>(request);
	if (typeof payload.name !== 'string' || typeof payload.bodyMd !== 'string') {
		error(400, 'name and bodyMd must be strings');
	}
	checkProseLength(payload.bodyMd);
	const rawTags = kind === 'lore' ? payload.keywords : payload.aliases;
	const tags = Array.isArray(rawTags)
		? rawTags.filter((tag): tag is string => typeof tag === 'string')
		: [];

	const result = await saveEntity(db, kind, entityId, userId, {
		name: payload.name,
		tags,
		summaryMd: typeof payload.summaryMd === 'string' ? payload.summaryMd : null,
		bodyMd: payload.bodyMd,
		details: payload.details !== undefined ? cleanDetails(payload.details) : undefined,
		// Characters and places accept null to clear the category; lore's
		// category is NOT NULL in the schema, so null is not accepted there.
		categoryId:
			payload.categoryId === null && kind !== 'lore'
				? null
				: typeof payload.categoryId === 'string'
					? payload.categoryId
					: undefined,
		storyId: typeof payload.storyId === 'string' ? payload.storyId : undefined,
		storyNotesMd: typeof payload.storyNotesMd === 'string' ? payload.storyNotesMd : undefined
	});
	if (!result.ok) {
		throwActionError(result);
	}
	if (result.mentionsAffected) {
		await queueUniverseMentions(result.universeId);
	}
	return json({ savedAt: new Date().toISOString() });
}
