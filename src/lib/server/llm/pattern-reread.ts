import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../auth';
import { reviewComments } from '../db/schema';
import { acceptedPatternEdit } from '../review';
import { paragraphWindow } from '#lib/paragraphs';
import { assembleReviewReplyContext, buildSystemMessage } from './context/assemble';
import { buildRereadMessage } from './prompts/review';
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
const REREAD_TOOL_BUDGET = 3;

export type RereadResult = { staged: number } | { skipped: 'gone' | 'not-found' };

export async function rereadPatternEdit(
	db: Database,
	input: { userId: string; suggestionId: string; signal?: AbortSignal },
	deps: GatewayDeps = {}
): Promise<RereadResult> {
	const edit = await acceptedPatternEdit(db, input.userId, input.suggestionId);
	if (!edit) return { skipped: 'gone' };
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
				storyOnly: true
			},
			messages: context ? [buildSystemMessage(context), task] : [task],
			signal: input.signal
		},
		deps
	);
	return { staged: result.notes };
}
