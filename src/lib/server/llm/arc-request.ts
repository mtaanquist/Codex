import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../auth.ts';
import { entityMentions, scenes, stories } from '../db/schema.ts';
import { storyAssistantOn } from '../universe-scope.ts';
import { buildArcMessage, type ArcScene } from './prompts/arc.ts';
import { requestHash } from './request-hash.ts';
import type { ChatMessage } from './providers/types.ts';
import { usableSceneSummary } from '../summary-currency.ts';

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

// storyIds are the stories whose scenes the request draws on.
export type ArcRequest = { messages: ChatMessage[]; input: string; storyIds: string[] };

// The request an arc refresh would send for each of these characters as
// things stand, with its fingerprint, in one read. The scenes are the live
// ones in the universe that mention the character, in reading order, each as
// its summary (while that is current) or else the passage around its first
// mention. A character no
// live scene the Assistant reads mentions has no entry.
export async function arcRequests(
	db: Database,
	universeId: string,
	characters: { id: string; name: string }[]
): Promise<Map<string, ArcRequest>> {
	const out = new Map<string, ArcRequest>();
	if (characters.length === 0) return out;
	// The first mention of each character in each scene, picked in the
	// database: a lead character is mentioned many times a scene, and only one
	// passage per scene is read.
	const first = db
		.selectDistinctOn([entityMentions.targetId, entityMentions.sourceId], {
			characterId: entityMentions.targetId,
			sceneId: entityMentions.sourceId,
			snippet: entityMentions.surroundingText
		})
		.from(entityMentions)
		.where(
			and(
				eq(entityMentions.sourceType, 'scene'),
				eq(entityMentions.targetType, 'character'),
				inArray(
					entityMentions.targetId,
					characters.map((c) => c.id)
				)
			)
		)
		.orderBy(
			asc(entityMentions.targetId),
			asc(entityMentions.sourceId),
			asc(entityMentions.position)
		)
		.as('first_mention');
	const rows = await db
		.select({
			characterId: first.characterId,
			sceneTitle: scenes.title,
			summaryMd: scenes.summaryMd,
			summaryGeneratedAt: scenes.summaryGeneratedAt,
			updatedAt: scenes.updatedAt,
			storyId: stories.id,
			storyTitle: stories.title,
			snippet: first.snippet
		})
		.from(first)
		.innerJoin(scenes, eq(scenes.id, first.sceneId))
		.innerJoin(stories, eq(stories.id, scenes.storyId))
		.where(
			and(
				eq(stories.universeId, universeId),
				isNull(stories.deletedAt),
				isNull(scenes.deletedAt),
				storyAssistantOn()
			)
		)
		.orderBy(asc(stories.positionInSeries), asc(stories.createdAt), asc(scenes.globalPosition));
	const found = new Map<string, (ArcScene & { storyId: string })[]>();
	for (const row of rows) {
		// A summary the Assistant wrote before the scene last changed tells an
		// older scene, so the passage is read instead until it is rewritten.
		const text = usableSceneSummary(row) || row.snippet.trim();
		if (!text) continue;
		let arcScenes = found.get(row.characterId);
		if (!arcScenes) found.set(row.characterId, (arcScenes = []));
		arcScenes.push({
			storyId: row.storyId,
			storyTitle: row.storyTitle,
			sceneTitle: row.sceneTitle,
			text
		});
	}
	for (const character of characters) {
		const sampled = sampleEvenly(found.get(character.id) ?? [], MAX_ARC_SCENES);
		if (sampled.length === 0) continue;
		const messages: ChatMessage[] = [
			{
				role: 'user',
				content: buildArcMessage(
					character.name,
					sampled.map(({ storyTitle, sceneTitle, text }) => ({ storyTitle, sceneTitle, text }))
				)
			}
		];
		out.set(character.id, {
			messages,
			input: requestHash(messages),
			storyIds: [...new Set(sampled.map((scene) => scene.storyId))]
		});
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
