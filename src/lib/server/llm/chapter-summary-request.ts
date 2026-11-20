import { buildChapterSummaryMessage } from './prompts/summary.ts';
import { requestHash } from './request-hash.ts';
import type { ChatMessage } from './providers/types.ts';

// The request a chapter's summary is written from, and the check that a stored
// summary still matches it. Kept apart from the job (summaries.ts) so the
// context builders can check a summary without loading the gateway.

export type ChapterSummaryRequest = { messages: ChatMessage[]; input: string };

// The request a chapter summary would be written from as things stand, with
// its fingerprint: the chapter's title and the summaries of its live scenes in
// reading order. Null when none of its scenes has a summary yet.
export function chapterSummaryRequest(
	title: string | null,
	sceneSummaries: (string | null)[]
): ChapterSummaryRequest | null {
	const summaries = sceneSummaries.map((s) => s?.trim()).filter((s): s is string => !!s);
	if (summaries.length === 0) return null;
	const messages: ChatMessage[] = [
		{ role: 'user', content: buildChapterSummaryMessage(title, summaries) }
	];
	return { messages, input: requestHash(messages) };
}

// Whether a chapter summary the Assistant wrote was written from the request
// that would be sent now. One with no fingerprint (written before they were
// stored) is out of date, and so is one whose scenes no longer have summaries.
// Not for a summary the writer wrote (no summary_generated_at): that one is
// never out of date.
export function generatedChapterSummaryIsCurrent(
	chapter: { summaryInput: string | null },
	request: ChapterSummaryRequest | null
): boolean {
	return !!request && request.input === chapter.summaryInput;
}

// The chapter summary to give the model: the stored one, unless the Assistant
// wrote it and it is out of date. The writer's own (no summary_generated_at)
// always stands.
export function chapterSummaryToSend(
	chapter: {
		title: string | null;
		summaryMd: string | null;
		summaryGeneratedAt: Date | null;
		summaryInput: string | null;
	},
	sceneSummaries: (string | null)[]
): string | null {
	if (!chapter.summaryGeneratedAt) return chapter.summaryMd;
	const request = chapterSummaryRequest(chapter.title, sceneSummaries);
	return generatedChapterSummaryIsCurrent(chapter, request) ? chapter.summaryMd : null;
}
