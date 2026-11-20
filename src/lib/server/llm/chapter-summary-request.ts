import { createHash } from 'node:crypto';
import { buildChapterSummaryMessage } from './prompts/summary.ts';
import { requestHash } from './request-hash.ts';
import type { ChatMessage } from './providers/types.ts';
import { usableSceneSummary, type SceneSummarySource } from '../summary-currency.ts';

// The request a chapter's summary is written from, and the check that a stored
// summary still matches it. Kept apart from the job (summaries.ts) so the
// context builders can check a summary without loading the gateway.

export type ChapterSummaryRequest = {
	messages: ChatMessage[];
	input: string;
	// The stand-in fingerprint migration 0094 gave a summary from before
	// fingerprints, for the same title and scene summaries.
	inputAtUpgrade: string;
};

// The request a chapter summary would be written from as things stand, with
// its fingerprint: the chapter's title and the summaries of its live scenes in
// reading order. A scene summary the Assistant wrote before the scene last
// changed is left out, so a chapter summary written from it reads as out of
// date as soon as the scene is edited; the summaries pass rewrites the scene
// summary first and the chapter from the result. Null when none of its scenes
// has a summary to go on.
export function chapterSummaryRequest(
	title: string | null,
	chapterScenes: SceneSummarySource[]
): ChapterSummaryRequest | null {
	const usable = chapterScenes.filter((scene) => usableSceneSummary(scene));
	const summaries = usable.map((scene) => usableSceneSummary(scene)!);
	if (summaries.length === 0) return null;
	const messages: ChatMessage[] = [
		{ role: 'user', content: buildChapterSummaryMessage(title, summaries) }
	];
	return {
		messages,
		input: requestHash(messages),
		inputAtUpgrade: chapterInputAtUpgrade(
			title,
			usable.map((scene) => scene.summaryMd!)
		)
	};
}

// What migration 0094 stored for a chapter summary written by a release
// before fingerprints (up to 3.21.4) that was current at the upgrade: a
// digest of the title and the scene summaries as stored, worked out here the
// way that migration's SQL does. Such a summary is current while this still
// matches, and the summaries pass swaps it for the real fingerprint without a
// call. Delete it, and inputAtUpgrade, once upgrades straight from those
// releases no longer matter; a summary still carrying one is then rewritten.
function chapterInputAtUpgrade(title: string | null, storedSummaries: string[]): string {
	const text = [title ?? '', storedSummaries.join('\x1f')].join('\x1f');
	return `at-upgrade:${createHash('md5').update(text, 'utf8').digest('hex')}`;
}

// Whether a chapter summary the Assistant wrote was written from the request
// that would be sent now. One with no fingerprint (written before they were
// stored, and not kept by migration 0094) is out of date, and so is one whose
// scenes no longer have summaries.
// Not for a summary the writer wrote (no summary_generated_at): that one is
// never out of date.
export function generatedChapterSummaryIsCurrent(
	chapter: { summaryInput: string | null },
	request: ChapterSummaryRequest | null
): boolean {
	if (!request) return false;
	return request.input === chapter.summaryInput || request.inputAtUpgrade === chapter.summaryInput;
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
	chapterScenes: SceneSummarySource[]
): string | null {
	if (!chapter.summaryGeneratedAt) return chapter.summaryMd;
	const request = chapterSummaryRequest(chapter.title, chapterScenes);
	return generatedChapterSummaryIsCurrent(chapter, request) ? chapter.summaryMd : null;
}
