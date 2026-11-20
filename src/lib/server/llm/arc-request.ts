import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { entityMentions, scenes, stories } from '../db/schema.ts';
import { storyAssistantOn } from '../universe-scope.ts';
import { buildArcMessage, type ArcScene } from './prompts/arc.ts';
import { requestHash } from './request-hash.ts';
import type { ChatMessage } from './providers/types.ts';

// The request a character's arc is written from, and the check that a stored
// arc still matches it. Kept apart from the job (arc-summary.ts) so the
// context builders can check an arc without loading the gateway.

const MAX_ARC_SCENES = 60;

// Up to max items spread evenly from first to last, so a long-running
// character keeps their opening and their latest scene. Exported for unit
// testing.
export function sampleEvenly<T>(items: T[], max: number): T[] {
	if (items.length <= max) return items;
	if (max <= 1) return items.slice(-1);
	const step = (items.length - 1) / (max - 1);
	return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]);
}

export type ArcRequest = { messages: ChatMessage[]; input: string };

// The request an arc refresh would send for each of these characters as
// things stand, with its fingerprint, in one read. The scenes are the live
// ones in the universe that mention the character, in reading order, each as
// its summary or else the passage around its first mention. A character no
// live scene the Assistant reads mentions has no entry.
export async function arcRequests(
	db: Database,
	universeId: string,
	characters: { id: string; name: string }[]
): Promise<Map<string, ArcRequest>> {
	const out = new Map<string, ArcRequest>();
	if (characters.length === 0) return out;
	const rows = await db
		.select({
			characterId: entityMentions.targetId,
			sceneId: scenes.id,
			sceneTitle: scenes.title,
			summaryMd: scenes.summaryMd,
			storyTitle: stories.title,
			snippet: entityMentions.surroundingText
		})
		.from(entityMentions)
		.innerJoin(scenes, eq(scenes.id, entityMentions.sourceId))
		.innerJoin(stories, eq(stories.id, scenes.storyId))
		.where(
			and(
				eq(entityMentions.sourceType, 'scene'),
				eq(entityMentions.targetType, 'character'),
				inArray(
					entityMentions.targetId,
					characters.map((c) => c.id)
				),
				eq(stories.universeId, universeId),
				isNull(stories.deletedAt),
				isNull(scenes.deletedAt),
				storyAssistantOn()
			)
		)
		.orderBy(
			asc(stories.positionInSeries),
			asc(stories.createdAt),
			asc(scenes.globalPosition),
			asc(entityMentions.position)
		);
	const found = new Map<string, { seen: Set<string>; scenes: ArcScene[] }>();
	for (const row of rows) {
		let entry = found.get(row.characterId);
		if (!entry) found.set(row.characterId, (entry = { seen: new Set(), scenes: [] }));
		if (entry.seen.has(row.sceneId)) continue;
		entry.seen.add(row.sceneId);
		const text = row.summaryMd?.trim() || row.snippet.trim();
		if (!text) continue;
		entry.scenes.push({ storyTitle: row.storyTitle, sceneTitle: row.sceneTitle, text });
	}
	for (const character of characters) {
		const arcScenes = found.get(character.id)?.scenes ?? [];
		if (arcScenes.length === 0) continue;
		const messages: ChatMessage[] = [
			{
				role: 'user',
				content: buildArcMessage(character.name, sampleEvenly(arcScenes, MAX_ARC_SCENES))
			}
		];
		out.set(character.id, { messages, input: requestHash(messages) });
	}
	return out;
}

// arcRequests for one character; null when no live scene the Assistant reads
// mentions them.
export async function arcRequest(
	db: Database,
	character: { id: string; name: string; universeId: string }
): Promise<ArcRequest | null> {
	return (await arcRequests(db, character.universeId, [character])).get(character.id) ?? null;
}

// Whether a stored arc was written from the request that would be sent now.
// An arc with no fingerprint (written before they were stored) is out of
// date, and so is one whose character no longer appears in any scene the
// Assistant reads.
export function arcIsCurrent(
	character: { arcSummaryMd: string | null; arcSummaryInput: string | null },
	request: ArcRequest | null
): boolean {
	return !!character.arcSummaryMd && !!request && request.input === character.arcSummaryInput;
}
