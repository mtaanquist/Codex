// The character-arc instruction: from the scenes a character appears in, across
// every story in the universe in reading order, the Assistant writes a short
// account of what happens to them. Each scene is given as its summary where it
// has one, otherwise the passage around the mention. The gateway prepends the
// persona message; this is the task turn. No tools. Shipped-fixed in v1.

export type ArcScene = {
	storyTitle: string;
	sceneTitle: string | null;
	// The scene's summary, or the passage around the mention when it has none.
	text: string;
};

export function buildArcMessage(name: string, scenes: ArcScene[]): string {
	const lines = scenes.map((scene, i) => {
		const where = [scene.storyTitle, scene.sceneTitle ?? ''].filter(Boolean).join(' / ');
		return `${i + 1}. [${where}] ${scene.text}`;
	});
	return [
		`Write a short account of what happens to the character "${name}" across these stories, in the order given.`,
		'Cover where they start, what changes for them, and where they are at the end of the latest scene. Use only what the scenes below support; never invent events.',
		'Reply with only the account, in plain prose of at most five sentences - no preamble, no heading, no list. When the scenes span more than one story, name the story at each turn.',
		'Write in the same language as the scenes.',
		'',
		'---',
		lines.join('\n')
	].join('\n');
}
