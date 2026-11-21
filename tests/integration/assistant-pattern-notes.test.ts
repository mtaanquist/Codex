import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import * as schema from '../../src/lib/server/db/schema';
import {
	reviewComments,
	reviewSuggestions,
	reviewThreads,
	scenes,
	stories,
	universes,
	users
} from '../../src/lib/server/db/schema';
import type { Database } from '../../src/lib/server/auth';
import { MAX_REASON_LENGTH } from '../../src/lib/suggestion-reason';
import type {
	ChatMessage,
	Provider,
	ProviderToolCall
} from '../../src/lib/server/llm/providers/types';
import { ensureTestDatabase, TEST_DATABASE_URL } from './test-db';

// Pattern notes and the guided pass over them (#1132): leave_pattern_note
// stages a note with its linked edits, the link survives the note being
// cleared, an accept can carry the owner's own wording, and the re-read after
// an accept stages at most a follow-up inside the paragraphs it was shown.

process.env.APP_SECRET = process.env.APP_SECRET || 'pattern-notes-test-secret';

const { saveAccountLlmConfig } = await import('../../src/lib/server/llm/config');
const { dispatchToolCall } = await import('../../src/lib/server/llm/tools/dispatch');
const { clearReviews, createSuggestion, createThread, decideSuggestion, listSuggestions } =
	await import('../../src/lib/server/review');
const { rereadPatternEdit } = await import('../../src/lib/server/llm/pattern-reread');

let pool: pg.Pool;
let db: Database;
let userId: string;
let universeId: string;
let storyId: string;
let sceneId: string;

const BODY = [
	'The elf crossed the ford. Kara looked back at the bank.',
	'The elf had seen the riders. Mira followed her into the water.',
	'Far behind them, the elf heard horns.'
].join('\n\n');

beforeAll(async () => {
	await ensureTestDatabase();
	pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
	db = drizzle(pool, { schema });
	await migrate(db, { migrationsFolder: 'drizzle' });
});

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await pool.query(
		'truncate table review_suggestions, review_comments, review_threads, revisions, scenes, chapters, stories, universes, users cascade'
	);
	const [user] = await db
		.insert(users)
		.values({ email: 'p@example.com', displayName: 'Pia', passwordHash: 'x', role: 'user' })
		.returning({ id: users.id });
	userId = user.id;
	const [universe] = await db
		.insert(universes)
		.values({ ownerId: userId, name: 'U' })
		.returning({ id: universes.id });
	universeId = universe.id;
	const [story] = await db
		.insert(stories)
		.values({ universeId, ownerId: userId, title: 'S' })
		.returning({ id: stories.id });
	storyId = story.id;
	const [scene] = await db
		.insert(scenes)
		.values({ storyId, globalPosition: 1, title: 'The Ford', bodyMd: BODY })
		.returning({ id: scenes.id });
	sceneId = scene.id;
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

function tool(
	name: string,
	args: Record<string, unknown>,
	scope?: Parameters<typeof dispatchToolCall>[0]['scope']
) {
	return dispatchToolCall(
		{ db, userId, universeId, storyId, scope },
		{ id: 'call', name, arguments: JSON.stringify(args) }
	);
}

const patternArgs = (
	edits: { original: string; replacement: string; reason?: string }[],
	kept?: unknown[]
) => ({
	sceneId,
	comment: 'Pattern note (POV epithets): Kara is often called the elf.',
	edits,
	...(kept ? { kept } : {})
});

describe('leave_pattern_note', () => {
	it('stages one whole-scene note and links every located edit to it', async () => {
		const outcome = await tool(
			'leave_pattern_note',
			patternArgs(
				[
					{
						original: 'The elf crossed',
						replacement: 'Kara crossed',
						reason: '  Her name keeps\nus close to her. '
					},
					{ original: 'The elf had seen', replacement: 'She had seen' }
				],
				[{ quote: 'the elf heard horns', reason: 'rhythm' }]
			)
		);
		expect(outcome.staged).toBe(true);
		expect(outcome.noteCount).toBe(3);

		const threads = await db.select().from(reviewThreads);
		expect(threads).toHaveLength(1);
		expect(threads[0].anchorStart).toBeNull();
		const [note] = await db.select().from(reviewComments);
		expect(note.assistant).toBe(true);
		expect(note.bodyMd).toContain('Pattern note (POV epithets)');
		expect(note.bodyMd).toContain('Left as is on purpose:\n- "the elf heard horns": rhythm');

		const suggestions = await listSuggestions(db, storyId);
		expect(suggestions).toHaveLength(2);
		expect(suggestions.every((s) => s.patternThreadId === threads[0].id)).toBe(true);
		expect(suggestions.map((s) => s.original).sort()).toEqual([
			'The elf crossed',
			'The elf had seen'
		]);
		// Each edit keeps its own reason, on one line; one without has none.
		const reasons = Object.fromEntries(suggestions.map((s) => [s.original, s.reason]));
		expect(reasons).toEqual({
			'The elf crossed': 'Her name keeps us close to her.',
			'The elf had seen': null
		});
	});

	it('reports edits that do not locate, and a retry adds to the same note', async () => {
		const first = await tool(
			'leave_pattern_note',
			patternArgs([
				{ original: 'The elf crossed', replacement: 'Kara crossed' },
				{ original: 'elf', replacement: 'she' },
				{ original: 'not in the scene', replacement: 'x' }
			])
		);
		expect(first.result).toContain('1 linked edit');
		expect(first.result).toContain('"elf": appears more than once');
		expect(first.result).toContain('"not in the scene": not found in the scene');

		const retry = await tool(
			'leave_pattern_note',
			patternArgs([{ original: 'the elf heard', replacement: 'she heard' }])
		);
		expect(retry.noteCount).toBe(1);
		const threads = await db.select({ id: reviewThreads.id }).from(reviewThreads);
		expect(threads).toHaveLength(1);
		const linked = await db
			.select({ id: reviewSuggestions.id })
			.from(reviewSuggestions)
			.where(eq(reviewSuggestions.patternThreadId, threads[0].id));
		expect(linked).toHaveLength(2);
	});

	it('keeps within its limits: a long kept list is cut, and a scoped turn is refused', async () => {
		const kept = Array.from({ length: 200 }, (_, i) => ({
			quote: `kept instance number ${i} of the elf`,
			reason: 'it helps the rhythm of the paragraph here'
		}));
		const outcome = await tool(
			'leave_pattern_note',
			patternArgs(
				[
					{ original: 'The elf crossed', replacement: 'Kara crossed' },
					{ original: '  ', replacement: 'x' }
				],
				kept
			)
		);
		expect(outcome.staged).toBe(true);
		expect(outcome.result).toContain('1 linked edit');
		expect(outcome.result).toContain('an edit with no original text');
		const [note] = await db.select().from(reviewComments);
		expect(note.bodyMd.length).toBeLessThanOrEqual(5000);
		expect(note.bodyMd).toContain('kept instance number 0 ');

		const scoped = await tool(
			'leave_pattern_note',
			patternArgs([{ original: 'The elf had seen', replacement: 'She had seen' }]),
			{ maxEdits: 1 }
		);
		expect(scoped.staged).toBe(false);
		expect(scoped.result).toContain('suggest_edit');
		expect(await db.select().from(reviewThreads)).toHaveLength(1);
	});

	it('refuses a note with no edits and a scene the user does not own', async () => {
		const empty = await tool('leave_pattern_note', patternArgs([]));
		expect(empty.staged).toBe(false);
		expect(empty.result).toContain('leave_comment');

		const [other] = await db
			.insert(users)
			.values({ email: 'o@example.com', displayName: 'O', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		const stranger = await dispatchToolCall(
			{ db, userId: other.id, universeId, storyId },
			{
				id: 'call',
				name: 'leave_pattern_note',
				arguments: JSON.stringify(
					patternArgs([{ original: 'The elf crossed', replacement: 'Kara crossed' }])
				)
			}
		);
		expect(stranger.staged).toBe(false);
		expect(await db.select().from(reviewThreads)).toHaveLength(0);
	});
});

describe('the pattern link', () => {
	async function note(): Promise<string> {
		const created = await createThread(db, {
			storyId,
			sceneId,
			anchor: null,
			author: { assistant: true },
			body: 'Pattern note (POV epithets): the elf.'
		});
		if (!created.ok) throw new Error(created.reason);
		return created.threadId;
	}

	it('stages nothing more on a note the writer has resolved', async () => {
		const threadId = await note();
		await db
			.update(reviewThreads)
			.set({ resolvedAt: new Date() })
			.where(eq(reviewThreads.id, threadId));
		const late = await tool(
			'suggest_edit',
			{ sceneId, original: 'The elf crossed', replacement: 'Kara crossed' },
			{ patternThreadId: threadId }
		);
		expect(late.staged).toBe(false);
		expect(late.result).toContain('resolved');
		expect(await listSuggestions(db, storyId)).toHaveLength(0);
	});

	it('links suggest_edit under a pattern scope and holds it to the edit window', async () => {
		const threadId = await note();
		const second = BODY.indexOf('The elf had seen');
		const windowEnd = BODY.indexOf('\n\nFar behind');
		const scope = {
			patternThreadId: threadId,
			editWindow: { sceneId, start: second, end: windowEnd }
		};
		const outside = await tool(
			'suggest_edit',
			{ sceneId, original: 'The elf crossed', replacement: 'Kara crossed' },
			scope
		);
		expect(outside.staged).toBe(false);
		expect(outside.result).toContain('outside the paragraphs under review');

		const inside = await tool(
			'suggest_edit',
			{ sceneId, original: 'Mira followed her', replacement: 'Mira followed Kara' },
			scope
		);
		expect(inside.staged).toBe(true);
		const [row] = await db.select().from(reviewSuggestions);
		expect(row.patternThreadId).toBe(threadId);
	});

	it('refuses a pattern note from another story', async () => {
		const threadId = await note();
		const [otherStory] = await db
			.insert(stories)
			.values({ universeId, ownerId: userId, title: 'Other' })
			.returning({ id: stories.id });
		const [otherScene] = await db
			.insert(scenes)
			.values({ storyId: otherStory.id, globalPosition: 1, bodyMd: 'The elf waits.' })
			.returning({ id: scenes.id });
		const result = await createSuggestion(db, {
			storyId: otherStory.id,
			sceneId: otherScene.id,
			author: { assistant: true },
			range: { start: 0, end: 7 },
			replacement: 'Kara',
			patternThreadId: threadId
		});
		expect(result).toEqual({ ok: false, reason: 'That pattern note does not exist.' });
	});

	it('refuses an edit whose passage moved since the caller found it', async () => {
		const [scene] = await db
			.select({ bodyMd: scenes.bodyMd })
			.from(scenes)
			.where(eq(scenes.id, sceneId));
		const result = await createSuggestion(db, {
			storyId,
			sceneId,
			author: { assistant: true },
			range: { start: 0, end: 7 },
			original: 'Not what is there',
			replacement: 'Kara'
		});
		expect(result.ok).toBe(false);
		const ok = await createSuggestion(db, {
			storyId,
			sceneId,
			author: { assistant: true },
			range: { start: 0, end: 7 },
			original: scene.bodyMd.slice(0, 7),
			replacement: 'Kara'
		});
		expect(ok.ok).toBe(true);
	});

	it('leaves the edits standing when the note is cleared', async () => {
		const threadId = await note();
		const staged = await createSuggestion(db, {
			storyId,
			sceneId,
			author: { assistant: true },
			range: { start: 0, end: 7 },
			replacement: 'Kara',
			patternThreadId: threadId
		});
		expect(staged.ok).toBe(true);
		await db
			.update(reviewThreads)
			.set({ resolvedAt: new Date() })
			.where(eq(reviewThreads.id, threadId));
		await clearReviews(db, storyId, 'finished', new Date(Date.now() + 60_000).toISOString());
		expect(await db.select().from(reviewThreads)).toHaveLength(0);
		const [row] = await db.select().from(reviewSuggestions);
		expect(row.status).toBe('pending');
		expect(row.patternThreadId).toBeNull();
	});

	it('accepts with the owner wording and records what was applied', async () => {
		const threadId = await note();
		const staged = await createSuggestion(db, {
			storyId,
			sceneId,
			author: { assistant: true },
			range: { start: 0, end: 7 },
			replacement: 'Kara',
			patternThreadId: threadId
		});
		if (!staged.ok) throw new Error(staged.reason);
		const empty = await decideSuggestion(db, userId, storyId, staged.suggestionId, true, '  ');
		expect(empty.ok).toBe(false);
		const result = await decideSuggestion(db, userId, storyId, staged.suggestionId, true, 'She');
		expect(result.ok).toBe(true);
		const [scene] = await db.select({ bodyMd: scenes.bodyMd }).from(scenes);
		expect(scene.bodyMd.startsWith('She crossed the ford.')).toBe(true);
		const [row] = await db.select().from(reviewSuggestions);
		expect(row.status).toBe('accepted');
		expect(row.replacement).toBe('She');
	});

	it('takes no rewording for an edit outside a pattern note', async () => {
		const staged = await createSuggestion(db, {
			storyId,
			sceneId,
			author: { assistant: true },
			range: { start: 0, end: 7 },
			replacement: 'Kara'
		});
		if (!staged.ok) throw new Error(staged.reason);
		const result = await decideSuggestion(db, userId, storyId, staged.suggestionId, true, 'She');
		expect(result.ok).toBe(false);
		const [row] = await db.select().from(reviewSuggestions);
		expect(row.status).toBe('pending');
		expect(row.replacement).toBe('Kara');
	});
});

describe('rereadPatternEdit', () => {
	function scripted(turns: { content: string; toolCalls?: ProviderToolCall[] }[]) {
		const seen: ChatMessage[][] = [];
		const offered: string[][] = [];
		let i = 0;
		const provider: Provider = {
			async *chatStream() {
				yield { type: 'done' };
			},
			async respond(req) {
				seen.push(req.messages);
				offered.push((req.tools ?? []).map((t) => t.name));
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

	async function acceptedEdit(): Promise<{ threadId: string; suggestionId: string }> {
		await tool(
			'leave_pattern_note',
			patternArgs([{ original: 'The elf had seen', replacement: 'She had seen' }])
		);
		const [row] = await db.select().from(reviewSuggestions);
		const decided = await decideSuggestion(db, userId, storyId, row.id, true);
		if (!decided.ok) throw new Error(decided.reason);
		return { threadId: row.patternThreadId!, suggestionId: row.id };
	}

	it('sends the changed paragraph and its neighbours and links a follow-up', async () => {
		const { threadId, suggestionId } = await acceptedEdit();
		const { provider, seen, offered } = scripted([
			{
				content: '',
				toolCalls: [
					{
						id: 't1',
						name: 'suggest_edit',
						arguments: JSON.stringify({
							sceneId,
							original: 'Mira followed her',
							replacement: 'Mira followed Kara',
							reason: `  "Her" could be either woman here.\n  ${'Naming her keeps it clear. '.repeat(20)}`
						})
					}
				]
			},
			{ content: 'One follow-up.' }
		]);
		const result = await rereadPatternEdit(db, { userId, suggestionId }, { provider });
		expect(result).toMatchObject({ staged: 1 });
		expect(offered[0]).toEqual(['suggest_edit']);
		const task = seen[0].filter((m) => m.role === 'user').at(-1)!.content;
		expect(task).toContain('now reads: "She had seen"');
		expect(task).toContain('The elf crossed the ford.');
		expect(task).toContain('Far behind them');
		const followUp = (await db.select().from(reviewSuggestions)).find(
			(s) => s.status === 'pending'
		);
		expect(followUp?.patternThreadId).toBe(threadId);
		// Linked to the accept it follows, so the pass can show the link after a
		// reload.
		expect(followUp?.followsSuggestionId).toBe(suggestionId);
		// The reason is kept on one line and cut at a word near the cap.
		expect(followUp?.reason).toMatch(/^"Her" could be either woman here\. Naming her/);
		expect(Array.from(followUp!.reason!).length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
		expect(followUp!.reason!.endsWith('...')).toBe(true);
		expect(result).toEqual({ staged: 1, ids: [followUp!.id] });
	});

	it('re-reads after an accept in a note a connected app left', async () => {
		const { threadId, suggestionId } = await acceptedEdit();
		// The note as an app would have left it, its client row since removed.
		await pool.query(
			`update review_comments set assistant = false, client_name = 'Writing Desk',
			 client_host = 'app.example' where thread_id = $1`,
			[threadId]
		);
		const call: ProviderToolCall = {
			id: 't1',
			name: 'suggest_edit',
			arguments: JSON.stringify({
				sceneId,
				original: 'Mira followed her',
				replacement: 'Mira followed Kara'
			})
		};
		const { provider } = scripted([{ content: '', toolCalls: [call] }, { content: 'done' }]);
		expect(await rereadPatternEdit(db, { userId, suggestionId }, { provider })).toMatchObject({
			staged: 1
		});
		// The follow-up is the Assistant's own, linked to the app's note.
		const followUp = (await db.select().from(reviewSuggestions)).find(
			(s) => s.status === 'pending'
		);
		expect(followUp).toMatchObject({
			assistant: true,
			clientHost: null,
			patternThreadId: threadId,
			followsSuggestionId: suggestionId
		});
	});

	it('does not re-read under a note a person opened', async () => {
		const { threadId, suggestionId } = await acceptedEdit();
		await pool.query(
			`update review_comments set assistant = false, author_user_id = $2 where thread_id = $1`,
			[threadId, userId]
		);
		const { provider, seen } = scripted([{ content: 'done' }]);
		expect(await rereadPatternEdit(db, { userId, suggestionId }, { provider })).toEqual({
			skipped: 'gone'
		});
		expect(seen).toHaveLength(0);
	});

	it('stages at most one follow-up, and only once per accepted edit', async () => {
		const { suggestionId } = await acceptedEdit();
		const call = (id: string, original: string, replacement: string): ProviderToolCall => ({
			id,
			name: 'suggest_edit',
			arguments: JSON.stringify({ sceneId, original, replacement })
		});
		const { provider, seen } = scripted([
			{
				content: '',
				toolCalls: [
					call('t1', 'Mira followed her', 'Mira followed Kara'),
					call('t2', 'Far behind them', 'Behind them')
				]
			},
			{ content: 'done' }
		]);
		expect(await rereadPatternEdit(db, { userId, suggestionId }, { provider })).toMatchObject({
			staged: 1
		});
		const calls = seen.length;
		expect(await rereadPatternEdit(db, { userId, suggestionId }, { provider })).toEqual({
			skipped: 'done'
		});
		expect(seen).toHaveLength(calls);
	});

	it('refuses a follow-up outside the window', async () => {
		const longer = [BODY, 'A fourth paragraph, where the elf rests.'].join('\n\n');
		await db.update(scenes).set({ bodyMd: longer }).where(eq(scenes.id, sceneId));
		await tool(
			'leave_pattern_note',
			patternArgs([{ original: 'The elf crossed', replacement: 'Kara crossed' }])
		);
		const [row] = await db.select().from(reviewSuggestions);
		await decideSuggestion(db, userId, storyId, row.id, true);
		const { provider } = scripted([
			{
				content: '',
				toolCalls: [
					{
						id: 't1',
						name: 'suggest_edit',
						arguments: JSON.stringify({
							sceneId,
							original: 'the elf rests',
							replacement: 'she rests'
						})
					}
				]
			},
			{ content: 'fine' }
		]);
		const result = await rereadPatternEdit(db, { userId, suggestionId: row.id }, { provider });
		expect(result).toEqual({ staged: 0, ids: [] });
		expect(
			(await db.select().from(reviewSuggestions)).filter((s) => s.status === 'pending')
		).toHaveLength(0);
	});

	it('skips an edit that is not an accepted pattern edit, or one the user does not own', async () => {
		const staged = await createSuggestion(db, {
			storyId,
			sceneId,
			author: { assistant: true },
			range: { start: 0, end: 7 },
			replacement: 'Kara'
		});
		if (!staged.ok) throw new Error(staged.reason);
		const { provider, seen } = scripted([{ content: 'fine' }]);
		expect(
			await rereadPatternEdit(db, { userId, suggestionId: staged.suggestionId }, { provider })
		).toEqual({ skipped: 'gone' });
		const { suggestionId } = await acceptedEdit();
		const [other] = await db
			.insert(users)
			.values({ email: 'q@example.com', displayName: 'Q', passwordHash: 'x', role: 'user' })
			.returning({ id: users.id });
		expect(await rereadPatternEdit(db, { userId: other.id, suggestionId }, { provider })).toEqual({
			skipped: 'gone'
		});
		expect(seen).toHaveLength(0);
	});
});
