import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	reviewComments,
	reviewThreads,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

process.env.APP_SECRET = process.env.APP_SECRET || 'continuity-test-secret';

import type {
	ChatMessage,
	Provider,
	ProviderToolCall
} from '../../src/lib/server/llm/providers/types';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { reviewStoryContinuity, reviewUniverseContinuity } =
	await import('../../src/lib/server/llm/scene-review');

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;

// Answers every request with an empty candidate list (the survey stage's "found
// nothing") and records what was asked, so a pass completes in one provider turn
// per survey chunk and the test can read the messages.
function recordingProvider(): { provider: Provider; seen: ChatMessage[][] } {
	const seen: ChatMessage[][] = [];
	const provider: Provider = {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond(req) {
			seen.push(req.messages);
			return { content: '[]', toolCalls: [] };
		},
		async listModels() {
			return [];
		}
	};
	return { provider, seen };
}

// Plays a fixed script of turns and records the messages of each, so a two-stage
// pass can be driven through its survey and confirm rounds. The last turn
// repeats once the script runs out.
function scriptedProvider(turns: { content: string; toolCalls?: ProviderToolCall[] }[]): {
	provider: Provider;
	seen: ChatMessage[][];
	offered: string[][];
} {
	const seen: ChatMessage[][] = [];
	const offered: string[][] = [];
	let i = 0;
	const provider: Provider = {
		async *chatStream() {
			yield { type: 'done' };
		},
		async respond(req) {
			seen.push(req.messages);
			offered.push((req.tools ?? []).map((tool) => tool.name));
			const turn = turns[Math.min(i, turns.length - 1)];
			i += 1;
			return { content: turn.content, toolCalls: turn.toolCalls ?? [] };
		},
		async listModels() {
			return [];
		}
	};
	return { provider, seen, offered };
}

// A survey reply naming one candidate contradiction.
const candidates = (entries: { sceneIds: string[]; claim: string }[]) => JSON.stringify(entries);

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

beforeEach(async () => {
	await pool.query(
		'truncate table review_suggestions, review_comments, review_threads, revisions, scenes, chapters, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 'c@example.com', displayName: 'Cee', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	universeId = universe.id;
	await saveAccountLlmConfig(db, userId, {
		enabled: true,
		assistantName: '',
		persona: 'balanced',
		endpoint: 'https://api.example.com/v1',
		apiKey: 'sk',
		models: { reviewer: 'review-model' },
		toolCallBudget: 8
	});
});

afterAll(async () => {
	await pool.end();
});

async function seedStory(
	title: string,
	sceneTitles: string[],
	startPosition = 1,
	filler = ''
): Promise<string> {
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title })
		.returning({ id: stories.id });
	for (let i = 0; i < sceneTitles.length; i++) {
		await db.insert(scenes).values({
			storyId: story.id,
			globalPosition: startPosition + i,
			title: sceneTitles[i],
			bodyMd: `Body of ${sceneTitles[i]}.${filler}`,
			// A summary the writer wrote (no generated-at watermark), so the pass
			// finds nothing stale and never enters the summary phase.
			summaryMd: `Summary of ${sceneTitles[i]}.${filler}`
		});
	}
	return story.id;
}

const userText = (messages: ChatMessage[]) =>
	messages
		.filter((m) => m.role === 'user')
		.map((m) => m.content)
		.join('\n');

describe('reviewStoryContinuity', () => {
	it('surveys every scene in one turn and stops when it finds no candidates', async () => {
		await seedStory('S', ['One', 'Two', 'Three']);
		const storyId = (await db.select({ id: stories.id }).from(stories))[0].id;
		const { provider, seen } = recordingProvider();
		const result = await reviewStoryContinuity(db, { userId, storyId }, { provider });

		expect(result.ran).toBe(true);
		expect(result.scenes).toBe(3);
		expect(result.candidates).toBe(0);
		expect(result.notes).toBe(0);
		// One provider turn: the survey. No confirm rounds, and no note staged
		// saying everything holds together.
		expect(seen).toHaveLength(1);
		const survey = userText(seen[0]);
		expect(survey).toContain('survey stage');
		expect(survey).toContain('One (id:');
		expect(survey).toContain('Three (id:');
		const threads = await db.select({ id: reviewThreads.id }).from(reviewThreads);
		expect(threads).toHaveLength(0);
	});

	it('confirms each candidate against the scene text and stages the ones that hold', async () => {
		const storyId = await seedStory('S', ['One', 'Two', 'Three']);
		const sceneRows = await db
			.select({ id: scenes.id, title: scenes.title })
			.from(scenes)
			.orderBy(scenes.globalPosition);
		const [one, two, three] = sceneRows;
		const { provider, seen, offered } = scriptedProvider([
			// The survey: two candidates.
			{
				content: candidates([
					{ sceneIds: [one.id, two.id], claim: 'The gate is shut in One and open in Two.' },
					{ sceneIds: [two.id, three.id], claim: 'Her rank changes between Two and Three.' }
				])
			},
			// The first confirm round holds up and stages a comment.
			{
				content: '',
				toolCalls: [
					{
						id: 'c1',
						name: 'leave_comment',
						arguments: JSON.stringify({
							sceneId: one.id,
							comment: 'The gate is shut here but open in Two.',
							quote: 'Body of One.'
						})
					}
				]
			},
			{ content: 'Staged one note.' },
			// The second is discarded, and repeats for any further round.
			{ content: 'discarded' }
		]);

		const result = await reviewStoryContinuity(db, { userId, storyId }, { provider });
		expect(result.ran).toBe(true);
		expect(result.candidates).toBe(2);
		expect(result.capped).toBe(false);
		expect(result.notes).toBe(1);

		// Survey, confirm one (two rounds around the tool call), confirm two.
		expect(seen).toHaveLength(4);
		// The survey has no tools; the confirm rounds only the two that stage a note.
		expect(offered[0]).toEqual([]);
		expect(offered[1].sort()).toEqual(['leave_comment', 'suggest_edit']);
		const confirm = userText(seen[1]);
		expect(confirm).toContain('confirm stage');
		expect(confirm).toContain('The gate is shut in One and open in Two.');
		// The scene text rides in the message, so no read tool is needed.
		expect(confirm).toContain('Body of One.');
		expect(confirm).toContain('Body of Two.');
		expect(confirm).not.toContain('Body of Three.');

		const threads = await db
			.select({ storyId: reviewThreads.storyId, sceneId: reviewThreads.sceneId })
			.from(reviewThreads);
		expect(threads).toHaveLength(1);
		expect(threads[0].sceneId).toBe(one.id);
	});

	it('skips a candidate whose scene ids are not in scope', async () => {
		const storyId = await seedStory('S', ['One', 'Two']);
		const { provider, seen } = scriptedProvider([
			{
				content: candidates([
					{ sceneIds: ['00000000-0000-0000-0000-000000000000'], claim: 'Invented.' }
				])
			},
			{ content: 'discarded' }
		]);
		const result = await reviewStoryContinuity(db, { userId, storyId }, { provider });
		expect(result.candidates).toBe(1);
		expect(result.notes).toBe(0);
		// The survey only: nothing to confirm.
		expect(seen).toHaveLength(1);
	});

	it('retries once when the survey reply is not JSON, then fails the pass', async () => {
		const storyId = await seedStory('S', ['One', 'Two']);
		const { provider, seen } = scriptedProvider([{ content: 'I found nothing of note.' }]);
		await expect(reviewStoryContinuity(db, { userId, storyId }, { provider })).rejects.toThrow(
			/JSON/
		);
		expect(seen).toHaveLength(2);
		expect(userText(seen[1])).toContain('That reply could not be read.');
	});

	it('splits the survey into chunks when the listing outgrows the window', async () => {
		const storyId = await seedStory('S', ['One', 'Two', 'Three', 'Four'], 1, 'x'.repeat(1400));
		// A small context window: the survey listing gets half of it, so four
		// long scenes cannot ride in one turn.
		await saveAccountLlmConfig(db, userId, {
			enabled: true,
			assistantName: '',
			persona: 'balanced',
			endpoint: 'https://api.example.com/v1',
			apiKey: 'sk',
			models: { reviewer: 'review-model' },
			toolCallBudget: 8,
			modelContextManual: { 'review-model': 2000 }
		});
		const { provider, seen } = recordingProvider();
		const result = await reviewStoryContinuity(db, { userId, storyId }, { provider });

		expect(result.ran).toBe(true);
		expect(seen.length).toBeGreaterThan(1);
		// Story order is preserved across the chunks, and each says it is a part.
		const listings = seen.map(userText);
		expect(listings[0]).toContain('One (id:');
		expect(listings[0]).toContain('part 1 of');
		expect(listings[listings.length - 1]).toContain('Four (id:');
		// No scene is surveyed twice.
		const mentions = listings.join('\n').match(/Four \(id:/g) ?? [];
		expect(mentions).toHaveLength(1);
	});

	it('skips the pass when the story has fewer than two scenes', async () => {
		await seedStory('S', ['Only']);
		const storyId = (await db.select({ id: stories.id }).from(stories))[0].id;
		const { provider, seen } = recordingProvider();
		const result = await reviewStoryContinuity(db, { userId, storyId }, { provider });

		expect(result.ran).toBe(false);
		expect(result.scenes).toBe(1);
		expect(seen).toHaveLength(0);
	});
});

describe('reviewUniverseContinuity', () => {
	it('surveys every story, grouped, and frames the pass as cross-story', async () => {
		await seedStory('First Light', ['Gate', 'Road'], 1);
		await seedStory('Second Dawn', ['Harbour'], 3);
		const { provider, seen } = recordingProvider();
		const result = await reviewUniverseContinuity(db, { userId, universeId }, { provider });

		expect(result.ran).toBe(true);
		expect(result.scenes).toBe(3);
		expect(result.candidates).toBe(0);
		expect(seen).toHaveLength(1);
		const survey = userText(seen[0]);
		expect(survey).toContain('universe-wide continuity pass');
		expect(survey).toContain('Story: First Light');
		expect(survey).toContain('Story: Second Dawn');
		expect(survey).toContain('Gate (id:');
	});

	it('stages a thread on the owning story even when launched at the universe', async () => {
		// Two stories; the contradiction is anchored on a scene in the first.
		const firstId = await seedStory('First Light', ['Gate', 'Road'], 1);
		const secondId = await seedStory('Second Dawn', ['Harbour'], 3);
		const [target] = await db
			.select({ id: scenes.id })
			.from(scenes)
			.where(and(eq(scenes.storyId, firstId), eq(scenes.title, 'Gate')));
		const [other] = await db
			.select({ id: scenes.id })
			.from(scenes)
			.where(and(eq(scenes.storyId, secondId), eq(scenes.title, 'Harbour')));

		const { provider, seen } = scriptedProvider([
			{
				content: candidates([
					{
						sceneIds: [target.id, other.id],
						claim: 'The harbour is east in First Light and west in Second Dawn.'
					}
				])
			},
			{
				content: '',
				toolCalls: [
					{
						id: 'c1',
						name: 'leave_comment',
						arguments: JSON.stringify({
							sceneId: target.id,
							comment: 'The harbour is east here but west in Second Dawn.',
							quote: 'Body of Gate.'
						})
					}
				]
			},
			{ content: 'Logged one contradiction.' }
		]);

		const result = await reviewUniverseContinuity(db, { userId, universeId }, { provider });
		expect(result.ran).toBe(true);
		expect(result.notes).toBe(1);
		// The confirm round carries both stories' scene text.
		const confirm = userText(seen[1]);
		expect(confirm).toContain('[story: First Light]');
		expect(confirm).toContain('[story: Second Dawn]');

		// The thread lands on the first story's scene, with the first story's id,
		// even though the pass ran at the universe.
		const threads = await db
			.select({ storyId: reviewThreads.storyId, sceneId: reviewThreads.sceneId })
			.from(reviewThreads);
		expect(threads).toHaveLength(1);
		expect(threads[0].storyId).toBe(firstId);
		expect(threads[0].sceneId).toBe(target.id);

		const comments = await db.select({ assistant: reviewComments.assistant }).from(reviewComments);
		expect(comments).toHaveLength(1);
		expect(comments[0].assistant).toBe(true);
	});
});
