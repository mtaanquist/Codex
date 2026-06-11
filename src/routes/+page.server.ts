import { fail, redirect } from '@sveltejs/kit';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { db, isUniqueViolation } from '$lib/server/db';
import { entityCategories, universes } from '$lib/server/db/schema';
import { uniqueSlug } from '$lib/server/slugs';
import { isUuid } from '$lib/slug';
import { createStoryInUniverse, standaloneUniverse } from '$lib/server/story-create';
import { relativeTime, storyStatus } from '$lib/dashboard';
import {
	destroyUniverse,
	listTrashedUniverses,
	restoreUniverse
} from '$lib/server/universe-lifecycle';
import { effectiveAssetConfig, s3AssetStore } from '$lib/server/assets';
import { signupMode } from '$lib/server/settings';

export const load: PageServerLoad = async ({ locals }) => {
	// Signed-out visitors get the landing page. The page checks the layout's
	// `user` for which face to show; returning a `user` key here would shadow
	// the layout's shape (and once dropped the admin link from the avatar menu
	// by losing its isAdmin flag).
	if (!locals.user) {
		return {
			universes: [],
			stories: [],
			trashedUniverses: [],
			signupOpen: (await signupMode(db)) !== 'none'
		};
	}
	const user = locals.user;
	const list = await db
		.select()
		.from(universes)
		.where(and(eq(universes.ownerId, user.id), isNull(universes.deletedAt)))
		.orderBy(desc(universes.updatedAt));
	const trashedUniverses = await listTrashedUniverses(db, user.id);

	// One row per story with everything its card shows: chapter and word
	// totals, scene status counts for the pill, and when anything in it
	// was last touched.
	const result = await db.execute(sql`
		select st.id, st.slug, st.title, st.brief, st.universe_id,
			st.position_in_series, st.created_at,
			(select count(*)::int from chapters c where c.story_id = st.id) as chapters,
			count(s.id)::int as scene_count,
			coalesce(sum(s.word_count), 0)::int as words,
			count(s.id) filter (where s.status = 'outline')::int as outline,
			count(s.id) filter (where s.status = 'draft')::int as draft,
			count(s.id) filter (where s.status = 'revised')::int as revised,
			count(s.id) filter (where s.status = 'final')::int as final,
			greatest(st.updated_at, max(s.updated_at)) as edited_at
		from stories st
		join universes u on u.id = st.universe_id and u.deleted_at is null
		left join scenes s on s.story_id = st.id and s.deleted_at is null
		where st.owner_id = ${user.id}
		group by st.id
		order by st.position_in_series asc nulls last, st.created_at asc
	`);
	const storyList = result.rows.map((row) => {
		const r = row as {
			id: string;
			slug: string;
			title: string;
			brief: string | null;
			universe_id: string;
			chapters: number;
			scene_count: number;
			words: number;
			outline: number;
			draft: number;
			revised: number;
			final: number;
			edited_at: string | Date;
		};
		const editedAt = new Date(r.edited_at);
		return {
			id: r.id,
			slug: r.slug,
			title: r.title,
			brief: r.brief,
			universeId: r.universe_id,
			chapters: r.chapters,
			words: r.words,
			editedAt: editedAt.toISOString(),
			editedLabel: relativeTime(editedAt, new Date()),
			status: storyStatus({
				sceneCount: r.scene_count,
				words: r.words,
				outline: r.outline,
				draft: r.draft,
				revised: r.revised,
				final: r.final
			})
		};
	});

	return {
		universes: list,
		stories: storyList,
		trashedUniverses
	};
};

export const actions: Actions = {
	createUniverse: async ({ request, locals }) => {
		// The route is public for the landing page; the action is not.
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const name = String(data.get('name') ?? '').trim();
		if (!name) {
			return fail(400, { scope: 'universe', message: 'Give the universe a name.' });
		}
		const create = (slug: string) =>
			db.transaction(async (tx) => {
				const [row] = await tx
					.insert(universes)
					.values({ ownerId: locals.user!.id, name, slug })
					.returning();
				// Every universe starts with a couple of categories; users rename
				// and extend from there.
				await tx.insert(entityCategories).values([
					{ universeId: row.id, ownerId: locals.user!.id, name: 'Lore', sortOrder: 0 },
					{ universeId: row.id, ownerId: locals.user!.id, name: 'Faction', sortOrder: 1 }
				]);
				return row;
			});
		let universe;
		try {
			universe = await create(await uniqueSlug(db, 'universes', locals.user.id, name, 'universe'));
		} catch (err) {
			// A concurrent create took the slug between the pick and the insert.
			if (!isUniqueViolation(err)) throw err;
			universe = await create(await uniqueSlug(db, 'universes', locals.user.id, name, 'universe'));
		}
		redirect(303, `/universes/${universe.slug}`);
	},
	// The dashboard's per-universe new-story card.
	createStory: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const universeId = String(data.get('universeId') ?? '');
		const title = String(data.get('title') ?? '').trim();
		if (!title) {
			return fail(400, { scope: 'story', universeId, message: 'Give the story a title.' });
		}
		// Guard the uuid cast: a tampered id would throw in Postgres and 500.
		if (!isUuid(universeId)) {
			return fail(404, { scope: 'story', universeId, message: 'That universe does not exist.' });
		}
		const [universe] = await db
			.select({ id: universes.id })
			.from(universes)
			.where(and(eq(universes.id, universeId), eq(universes.ownerId, locals.user.id)));
		if (!universe) {
			return fail(404, { scope: 'story', universeId, message: 'That universe does not exist.' });
		}
		const story = await createStoryInUniverse(db, locals.user.id, universe.id, title);
		redirect(303, `/stories/${story.slug}`);
	},
	// The header's "New story": a story on its own, filed under the owner's
	// lazily created "Standalone stories" universe.
	createStandaloneStory: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const title = String((await request.formData()).get('title') ?? '').trim();
		if (!title) {
			return fail(400, { scope: 'standalone', message: 'Give the story a title.' });
		}
		const universe = await standaloneUniverse(db, locals.user.id);
		const story = await createStoryInUniverse(db, locals.user.id, universe.id, title);
		redirect(303, `/stories/${story.slug}`);
	},
	restoreUniverse: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const universeId = String(data.get('universeId') ?? '');
		if (!isUuid(universeId)) {
			return fail(404, { scope: 'trash', message: 'That universe is not in the trash.' });
		}
		const ok = await restoreUniverse(db, locals.user.id, universeId);
		if (!ok) return fail(404, { scope: 'trash', message: 'That universe is not in the trash.' });
		return { scope: 'trash', restored: true };
	},
	destroyUniverse: async ({ request, locals }) => {
		if (!locals.user) redirect(303, '/login');
		const data = await request.formData();
		const universeId = String(data.get('universeId') ?? '');
		if (!isUuid(universeId)) {
			return fail(404, { scope: 'trash', message: 'That universe is not in the trash.' });
		}
		const result = await destroyUniverse(db, locals.user.id, universeId);
		if (!result.ok) {
			return fail(404, { scope: 'trash', message: 'That universe is not in the trash.' });
		}
		// Best-effort object sweep; an orphaned image is never a blocker.
		const config = await effectiveAssetConfig(db);
		if (config) {
			const store = s3AssetStore(config);
			for (const key of result.assetKeys) await store.remove(key).catch(() => {});
		}
		return { scope: 'trash', destroyed: true };
	}
};
