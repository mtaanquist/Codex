import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from './auth';
import { publicationAssets, publications, stories, users } from './db/schema';
import { gatherStory } from './export';
import { findAssetReferences } from '$lib/markdown';
import { isUniqueViolation } from './db-errors';

// Publishing freezes the story's current prose into an edition; the
// public reading pages serve only these snapshots, never live drafts.

export type EditionContent = {
	chapters: { title: string | null; scenes: { title: string | null; bodyMd: string }[] }[];
	unfiled: { title: string | null; bodyMd: string }[];
};

export async function publishStory(
	db: Database,
	userId: string,
	storyId: string,
	versionLabel?: string
): Promise<{ ok: true; publicationId: string } | { ok: false; reason: string }> {
	const [user] = await db
		.select({ handle: users.handle, enabled: users.publicArchiveEnabled })
		.from(users)
		.where(eq(users.id, userId));
	if (!user?.enabled) {
		return { ok: false, reason: 'the site admin has not enabled your public archive' };
	}
	if (!user.handle) return { ok: false, reason: 'claim a public handle first' };
	const [story] = await db
		.select()
		.from(stories)
		.where(and(eq(stories.id, storyId), eq(stories.ownerId, userId)));
	if (!story) return { ok: false, reason: 'story not found' };

	const { chapters: chapterList, scenes: sceneList } = await gatherStory(db, story);
	const content: EditionContent = {
		chapters: chapterList
			.map((chapter) => ({
				title: chapter.title,
				scenes: sceneList
					.filter((scene) => scene.chapterId === chapter.id)
					.map((scene) => ({ title: scene.title, bodyMd: scene.bodyMd }))
			}))
			.filter((chapter) => chapter.scenes.length > 0),
		unfiled: sceneList
			.filter((scene) => scene.chapterId === null)
			.map((scene) => ({ title: scene.title, bodyMd: scene.bodyMd }))
	};
	if (content.chapters.length === 0 && content.unfiled.length === 0) {
		return { ok: false, reason: 'there is nothing to publish yet' };
	}

	// Inline images the frozen prose points at, so the reader can serve them
	// to anonymous visitors without exposing every asset by id.
	const referencedAssets = [
		...new Set([
			...content.chapters.flatMap((chapter) =>
				chapter.scenes.flatMap((scene) => findAssetReferences(scene.bodyMd))
			),
			...content.unfiled.flatMap((scene) => findAssetReferences(scene.bodyMd))
		])
	];

	try {
		const publicationId = await db.transaction(async (tx) => {
			await tx
				.update(publications)
				.set({ isCurrent: false })
				.where(and(eq(publications.storyId, story.id), eq(publications.isCurrent, true)));
			const [edition] = await tx
				.insert(publications)
				.values({
					storyId: story.id,
					ownerId: userId,
					handle: user.handle!,
					title: story.title,
					author: story.author,
					descriptionMd: story.descriptionMd,
					isAdult: story.isAdult,
					content,
					versionLabel: versionLabel?.trim() || null
				})
				.returning({ id: publications.id });
			if (referencedAssets.length > 0) {
				await tx
					.insert(publicationAssets)
					.values(referencedAssets.map((assetId) => ({ publicationId: edition.id, assetId })));
			}
			return edition.id;
		});
		return { ok: true, publicationId };
	} catch (error) {
		// The partial unique index caught a concurrent publish of the same
		// story; the loser rolls back rather than leaving two current rows.
		if (isUniqueViolation(error)) {
			return { ok: false, reason: 'another publish just happened; reload and try again' };
		}
		throw error;
	}
}

// The author shelf: current, non-removed editions of stories the author
// has set public. Unlisted stories stay reachable by direct link only.
export async function publicShelf(db: Database, handle: string) {
	return await db
		.select({
			storyId: publications.storyId,
			title: publications.title,
			author: publications.author,
			descriptionMd: publications.descriptionMd,
			isAdult: publications.isAdult,
			publishedAt: publications.publishedAt,
			coverAssetId: stories.coverAssetId
		})
		.from(publications)
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(
			and(
				eq(publications.handle, handle),
				eq(publications.isCurrent, true),
				isNull(publications.removedAt),
				eq(stories.visibility, 'public')
			)
		)
		.orderBy(desc(publications.publishedAt));
}

// The author's public profile for the shelf header: identity, bio, links, and
// commissions. Only returned when the profile is listed publicly, so a private
// page never leaks the author's details even if editions exist.
export async function publicProfile(db: Database, handle: string) {
	const [row] = await db
		.select({
			displayName: users.displayName,
			penName: users.penName,
			bioMd: users.bioMd,
			links: users.links,
			commissionsOpen: users.commissionsOpen,
			commissionsMd: users.commissionsMd,
			avatarAssetId: users.avatarAssetId
		})
		.from(users)
		.where(and(eq(users.handle, handle), eq(users.profilePublic, true)));
	return row ?? null;
}

// True when an asset is the current avatar of a user whose profile is listed
// publicly, which makes it servable without a session. Turning the profile
// private or changing the avatar revokes public access immediately.
export async function isPublicAvatar(db: Database, assetId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.avatarAssetId, assetId), eq(users.profilePublic, true)))
		.limit(1);
	return Boolean(row);
}

// The reader view: the current edition, provided the story is not
// private and no takedown applies.
export async function publicEdition(db: Database, handle: string, storyId: string) {
	const [edition] = await db
		.select({
			id: publications.id,
			title: publications.title,
			author: publications.author,
			descriptionMd: publications.descriptionMd,
			isAdult: publications.isAdult,
			content: publications.content,
			versionLabel: publications.versionLabel,
			downloadsPublic: publications.downloadsPublic,
			publishedAt: publications.publishedAt,
			visibility: stories.visibility,
			coverAssetId: stories.coverAssetId
		})
		.from(publications)
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(
			and(
				eq(publications.handle, handle),
				eq(publications.storyId, storyId),
				eq(publications.isCurrent, true),
				isNull(publications.removedAt)
			)
		);
	if (!edition || edition.visibility === 'private') return null;
	return edition;
}

// True when an asset belongs to a publicly readable edition, which makes
// it servable without a session: either the story's live cover, or an
// inline image the frozen prose references. The visibility test mirrors
// publicEdition exactly (private excluded, unlisted reachable by link), so
// an asset never outlives the page it belongs to.
export async function isPublicAsset(db: Database, assetId: string): Promise<boolean> {
	const [cover] = await db
		.select({ id: publications.id })
		.from(publications)
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(
			and(
				eq(stories.coverAssetId, assetId),
				eq(publications.isCurrent, true),
				isNull(publications.removedAt),
				ne(stories.visibility, 'private')
			)
		)
		.limit(1);
	if (cover) return true;

	const [inline] = await db
		.select({ id: publications.id })
		.from(publicationAssets)
		.innerJoin(publications, eq(publicationAssets.publicationId, publications.id))
		.innerJoin(stories, eq(publications.storyId, stories.id))
		.where(
			and(
				eq(publicationAssets.assetId, assetId),
				eq(publications.isCurrent, true),
				isNull(publications.removedAt),
				ne(stories.visibility, 'private')
			)
		)
		.limit(1);
	return Boolean(inline);
}

// Admin takedown: hides the edition without touching the author's source.
export async function takedownPublication(db: Database, publicationId: string): Promise<boolean> {
	const updated = await db
		.update(publications)
		.set({ removedAt: new Date() })
		.where(and(eq(publications.id, publicationId), isNull(publications.removedAt)))
		.returning({ id: publications.id });
	return updated.length > 0;
}

// The admin's view of everything published on this instance.
export async function listPublications(db: Database, limit = 50) {
	return await db
		.select({
			id: publications.id,
			handle: publications.handle,
			title: publications.title,
			isAdult: publications.isAdult,
			isCurrent: publications.isCurrent,
			removedAt: publications.removedAt,
			publishedAt: publications.publishedAt
		})
		.from(publications)
		.orderBy(desc(publications.publishedAt))
		.limit(limit);
}
