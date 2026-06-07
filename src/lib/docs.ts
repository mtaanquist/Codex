// In-app help: articles are committed markdown under ./docs, rendered through
// the shared markdown renderer. The registry below sets the order and the
// one-line summaries shown on the help index; article titles come from each
// file's first heading, so they stay with the article.

// Eagerly bundled so both the index and an article page can resolve content
// without a filesystem read at request time.
const files = import.meta.glob('./docs/*.md', {
	eager: true,
	query: '?raw',
	import: 'default'
}) as Record<string, string>;

function bySlug(slug: string): string | null {
	return files[`./docs/${slug}.md`] ?? null;
}

// The first level-one heading, used as the article and page title.
function headingOf(markdown: string): string {
	const match = markdown.match(/^#\s+(.+)$/m);
	return match ? match[1].trim() : 'Help';
}

export type DocTopic = { slug: string; title: string; summary: string };

// Ordered for the help index. Summaries are the index blurbs; titles are read
// from the files so a renamed heading cannot drift from the article.
const REGISTRY: { slug: string; summary: string }[] = [
	{
		slug: 'getting-started',
		summary: 'Universes, stories, and scenes, and how to make your first one.'
	},
	{ slug: 'editor', summary: 'Drafting scenes, mentions, and marks in the editor.' },
	{ slug: 'planning', summary: 'Characters, places, lore, the outline, and relationships.' },
	{ slug: 'publishing', summary: 'Turning a finished story into a public reading page.' },
	{ slug: 'reviewing', summary: 'Asking someone to read a story and leave comments.' },
	{ slug: 'account', summary: 'Your profile, public page, appearance, and editor defaults.' },
	{ slug: 'security', summary: 'Password, two-factor, passkeys, sessions, export, and deletion.' },
	{ slug: 'shortcuts', summary: 'The keyboard shortcuts worth knowing.' }
];

export function docTopics(): DocTopic[] {
	return REGISTRY.map(({ slug, summary }) => ({
		slug,
		summary,
		title: headingOf(bySlug(slug) ?? '')
	}));
}

export type DocArticle = { slug: string; title: string; body: string };

export function docArticle(slug: string): DocArticle | null {
	const body = bySlug(slug);
	if (body === null) return null;
	return { slug, title: headingOf(body), body };
}
