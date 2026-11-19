import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../auth';
import { reviewComments, reviewSuggestions } from '../db/schema';
import { acceptedPatternEdit } from '../review';
import { paragraphWindow } from '#lib/paragraphs';
import { assembleReviewReplyContext, buildSystemMessage } from './context/assemble';
import { buildRereadMessage } from './prompts/review';
import { resolveLlmConfig } from './config';
import { completeDetailed, type GatewayDeps } from './gateway';
import type { ChatMessage } from './providers/types';

// The re-read after the writer accepts one fix from a pattern note during the
// guided pass: the Assistant reads the changed paragraph and one either side,
// and stages at most one follow-up edit there, linked to the same note so the
// pass picks it up as its next step. Only suggest_edit is offered, held to that
// stretch of the scene.

// Each side of the changed paragraph.
const NEIGHBOURS = 1;
// One edit and an answer; a little room for a retry of an edit that misquoted.
// The gateway never goes below the account's own budget, so maxEdits in the
// scope is what holds the re-read to one follow-up.
const REREAD_TOOL_BUDGET = 3;

// Accepted edits already re-read by this process. The client asks once per
// accept; this stops a repeat (a double fire, a retry) from paying for the
// same re-read again and stacking follow-ups. Bounded, oldest first out.
const reread = new Set<string>();
const REREAD_MEMORY = 5000;

// ids are the follow-up edits this re-read staged, so the pass can show them
// next rather than mistake them for edits from a review still running.
export type RereadResult =
	{ staged: number; ids: string[] } | { skipped: 'gone' | 'not-found' | 'done' };

export async function rereadPatternEdit(
	db: Database,
	input: { userId: string; suggestionId: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<RereadResult> {
	const edit = await acceptedPatternEdit(db, input.userId, input.suggestionId);
	if (!edit) return { skipped: 'gone' };
	// A follow-up is staged through suggest_edit; without tools there is none.
	const { config } = await resolveLlmConfig(db, input.userId, edit.storyId);
	if (config.supportsTools === false) return { skipped: 'done' };
	if (reread.has(input.suggestionId)) return { skipped: 'done' };
	reread.add(input.suggestionId);
	if (reread.size > REREAD_MEMORY) reread.delete(reread.values().next().value!);
	if (!edit.spot) return { skipped: 'not-found' };
	const [note] = await db
		.select({ body: reviewComments.bodyMd })
		.from(reviewComments)
		.where(
			and(eq(reviewComments.threadId, edit.patternThreadId), eq(reviewComments.assistant, true))
		)
		.orderBy(asc(reviewComments.createdAt))
		.limit(1);
	if (!note) return { skipped: 'gone' };

	const window = paragraphWindow(edit.bodyMd, edit.spot.start, edit.spot.end, NEIGHBOURS);
	const task: ChatMessage = {
		role: 'user',
		content: buildRereadMessage({
			sceneId: edit.sceneId,
			sceneTitle: edit.sceneTitle,
			passage: edit.bodyMd.slice(window.start, window.end),
			changed: edit.replacement,
			note: note.body
		})
	};
	// The slim review-reply frame: the style notes the pattern was judged
	// against and the entities the passage may name.
	const context = await assembleReviewReplyContext(db, {
		userId: input.userId,
		storyId: edit.storyId
	});
	const pendingHere = async () =>
		(
			await db
				.select({ id: reviewSuggestions.id })
				.from(reviewSuggestions)
				.where(
					and(
						eq(reviewSuggestions.patternThreadId, edit.patternThreadId),
						eq(reviewSuggestions.sceneId, edit.sceneId),
						eq(reviewSuggestions.status, 'pending')
					)
				)
		).map((row) => row.id);
	const before = new Set(await pendingHere());
	// A re-read that fails can be asked for again.
	const result = await completeDetailed(
		db,
		{
			userId: input.userId,
			storyId: edit.storyId,
			role: 'reviewer',
			enableTools: true,
			toolNames: ['suggest_edit'],
			toolBudget: REREAD_TOOL_BUDGET,
			toolScope: {
				patternThreadId: edit.patternThreadId,
				editWindow: { sceneId: edit.sceneId, ...window },
				maxEdits: 1,
				storyOnly: true
			},
			messages: context ? [buildSystemMessage(context), task] : [task],
			signal: input.signal
		},
		deps
	).catch((err: unknown) => {
		reread.delete(input.suggestionId);
		throw err;
	});
	if (!result.notes) return { staged: 0, ids: [] };
	const ids = (await pendingHere()).filter((id) => !before.has(id));
	return { staged: result.notes, ids };
}
