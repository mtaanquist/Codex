// An Assistant summary is current while the row has not changed since it was
// written: summary_generated_at at or after updated_at. The summary job stamps
// it with the updated_at it read, never a clock, so the comparison does not
// depend on which clock set updated_at. The job refreshes one that is not.
export function summaryIsCurrent(generatedAt: Date | null, updatedAt: Date): boolean {
	return generatedAt !== null && generatedAt.getTime() >= updatedAt.getTime();
}

// The summary_generated_at a copied row (a duplicated scene, a scene added
// back from a draft, a new story's chapters and scenes) gets. A summary that
// was current for the text being copied stays current on the copy: it is
// stamped with the copy's own updated_at, so the next pass does not pay to
// summarise the same text again. A stale one keeps its old stamp, older than
// the copy, so it is refreshed. Null (the writer's own summary) stays null.
export function copiedSummaryStamp(
	generatedAt: Date | null,
	current: boolean,
	copyUpdatedAt: Date
): Date | null {
	if (!generatedAt) return null;
	return current ? copyUpdatedAt : generatedAt;
}

export type SceneSummarySource = {
	summaryMd: string | null;
	summaryGeneratedAt: Date | null;
	updatedAt: Date;
};

// The summary of a scene that something else (an arc, a chapter summary) may
// be written from: the writer's own, or the Assistant's while it is current.
// One the Assistant wrote before the scene last changed tells an older scene,
// so it counts as no summary until the summaries pass rewrites it.
export function usableSceneSummary(scene: SceneSummarySource): string | null {
	const text = scene.summaryMd?.trim();
	if (!text) return null;
	if (!scene.summaryGeneratedAt) return text;
	return summaryIsCurrent(scene.summaryGeneratedAt, scene.updatedAt) ? text : null;
}
