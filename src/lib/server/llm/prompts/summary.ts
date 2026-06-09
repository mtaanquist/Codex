// The summary-maintenance instructions: the Assistant drafts a one or two line
// summary of a scene from its prose, and a short summary of a chapter from its
// scenes' summaries. The gateway prepends the persona message; these are the
// task turns. No tools, no world context beyond the text supplied - a summary
// describes what is on the page. Shipped-fixed in v1 (see assistant.md).

export function buildSceneSummaryMessage(title: string | null, bodyMd: string): string {
	const name = title?.trim() ? `the scene "${title.trim()}"` : 'this scene';
	return [
		`Summarise ${name} in one or two sentences: what happens in it, plainly.`,
		'Reply with only the summary - no preamble, no heading, no quotation marks. Keep it factual and spoiler-plain; this is a note to the writer, not back-cover copy.',
		'Write in the same language as the scene.',
		'',
		'---',
		bodyMd.trim()
	].join('\n');
}

export function buildChapterSummaryMessage(title: string | null, sceneSummaries: string[]): string {
	const name = title?.trim() ? `the chapter "${title.trim()}"` : 'this chapter';
	return [
		`Summarise ${name} in one or two sentences, drawing on its scene summaries below.`,
		'Reply with only the summary - no preamble, no heading. Capture the through-line of the chapter, not a list of every scene.',
		'Write in the same language as the summaries.',
		'',
		'---',
		sceneSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')
	].join('\n');
}
