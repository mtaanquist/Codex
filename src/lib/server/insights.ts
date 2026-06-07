// Queries behind the universe Insights view. Everything here is derived from
// data the app already records (scene word counts, the mention index, scene
// revisions, relationships); nothing is stored.
import { eq, sql } from 'drizzle-orm';
import type { Database } from './auth';
import { entityRelationships, relationTypes } from './db/schema';
import { dailyNetWords, dayAxis, streaks, type DailyWords } from '../insights';
import type { WebLink } from '../relationship-web';

export type StoryProgress = {
	id: string;
	slug: string;
	title: string;
	sceneCount: number;
	words: number;
	status: { outline: number; draft: number; revised: number; final: number };
};

export type EntityHeat = {
	id: string;
	type: 'character' | 'place' | 'lore_entry';
	name: string;
	color: string | null;
	// False when the entity has no body text yet: named but not written up.
	hasBody: boolean;
	mentionCount: number;
	sceneCount: number;
};

export type WritingActivity = {
	// Today in the requested timezone; the chart's last day.
	today: string;
	// One entry per day, oldest first, zero-filled.
	daily: DailyWords[];
	streak: { current: number; longest: number };
};

// Word count for prose, matching src/lib/word-count.ts: the number of maximal
// runs of non-whitespace. Postgres POSIX \s is ASCII-only, so the Unicode
// spaces JS \s treats as whitespace (NBSP and friends) are first normalised to
// a space; otherwise this SQL total would drift from the stored, JS-computed
// scenes.word_count for prose using those characters.
const UNICODE_WS = '\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
export const WORDS_SQL = (column: string) =>
	`(select count(*)::int from regexp_matches(regexp_replace(${column}, '[${UNICODE_WS}]', ' ', 'g'), '\\S+', 'g'))`;

export async function storyProgress(db: Database, universeId: string): Promise<StoryProgress[]> {
	const result = await db.execute(sql`
		select st.id, st.title, st.slug,
			count(s.id)::int as scene_count,
			coalesce(sum(s.word_count), 0)::int as words,
			count(s.id) filter (where s.status = 'outline')::int as outline,
			count(s.id) filter (where s.status = 'draft')::int as draft,
			count(s.id) filter (where s.status = 'revised')::int as revised,
			count(s.id) filter (where s.status = 'final')::int as final
		from stories st
		left join scenes s on s.story_id = st.id and s.deleted_at is null
		where st.universe_id = ${universeId}
		group by st.id
		order by st.position_in_series asc, st.created_at asc
	`);
	return result.rows.map((row) => {
		const r = row as {
			id: string;
			slug: string;
			title: string;
			scene_count: number;
			words: number;
			outline: number;
			draft: number;
			revised: number;
			final: number;
		};
		return {
			id: r.id,
			slug: r.slug,
			title: r.title,
			sceneCount: r.scene_count,
			words: r.words,
			status: { outline: r.outline, draft: r.draft, revised: r.revised, final: r.final }
		};
	});
}

// Every entity in the universe with how often the prose mentions it, ordered
// most-mentioned first so the heatmap reads centre-outwards.
export async function entityHeat(db: Database, universeId: string): Promise<EntityHeat[]> {
	const result = await db.execute(sql`
		select x.type, x.id, x.name, x.color, x.has_body,
			count(m.id)::int as mention_count,
			count(distinct m.source_id)::int as scene_count
		from (
			select 'character' as type, c.id, c.name, cat.color, btrim(c.body_md) <> '' as has_body
			from characters c
			left join entity_categories cat on cat.id = c.category_id
			where c.universe_id = ${universeId}
			union all
			select 'place', p.id, p.name, cat.color, btrim(p.body_md) <> ''
			from places p
			left join entity_categories cat on cat.id = p.category_id
			where p.universe_id = ${universeId}
			union all
			select 'lore_entry', l.id, l.title, cat.color, btrim(l.body_md) <> ''
			from lore_entries l
			left join entity_categories cat on cat.id = l.category_id
			where l.universe_id = ${universeId}
		) x
		left join entity_mentions m on m.target_type = x.type and m.target_id = x.id
		group by x.type, x.id, x.name, x.color, x.has_body
		order by mention_count desc, x.name asc
	`);
	return result.rows.map((row) => {
		const r = row as {
			type: EntityHeat['type'];
			id: string;
			name: string;
			color: string | null;
			has_body: boolean;
			mention_count: number;
			scene_count: number;
		};
		return {
			id: r.id,
			type: r.type,
			name: r.name,
			color: r.color,
			hasBody: r.has_body,
			mentionCount: r.mention_count,
			sceneCount: r.scene_count
		};
	});
}

/**
 * Net words written per day over the last `days` days, plus writing streaks
 * over the last year, derived from scene revisions. Day boundaries follow the
 * given IANA timezone so a late session does not split across two days.
 */
export async function writingActivity(
	db: Database,
	universeId: string,
	timezone: string,
	days = 30,
	// Narrows the word counts to one story; streaks stay as computed over
	// whatever the filter covers, so callers wanting a universe streak pass
	// no story.
	storyId?: string
): Promise<WritingActivity> {
	const storyFilter = storyId ? sql` and st.id = ${storyId}` : sql``;
	// The last revision per scene per day carries the scene's end-of-day word
	// count; the inner distinct-on picks the row, the outer counts its words
	// so bodies of discarded rows are never counted.
	// The day lands in an inner select first: distinct-on must name the very
	// expression the order-by uses, and two ${timezone} bindings read as two
	// different expressions to the parser.
	const windowRows = await db.execute(sql`
		select picked.entity_id, picked.day, ${sql.raw(WORDS_SQL('picked.body_md'))}::int as words
		from (
			select distinct on (x.entity_id, x.day) x.entity_id, x.day, x.body_md
			from (
				select r.entity_id,
					((r.created_at at time zone ${timezone})::date)::text as day,
					r.body_md,
					r.created_at
				from revisions r
				join scenes s on s.id = r.entity_id and s.deleted_at is null
				join stories st on st.id = s.story_id
				where r.entity_type = 'scene'
					and st.universe_id = ${universeId}
					and (r.created_at at time zone ${timezone})::date > (now() at time zone ${timezone})::date - ${days}::int${storyFilter}
			) x
			order by x.entity_id, x.day, x.created_at desc
		) picked
	`);
	// Each scene's last word count from before the window, so the first
	// in-window day diffs against real prior work instead of zero.
	const baselineRows = await db.execute(sql`
		select picked.entity_id, ${sql.raw(WORDS_SQL('picked.body_md'))}::int as words
		from (
			select distinct on (r.entity_id) r.entity_id, r.body_md
			from revisions r
			join scenes s on s.id = r.entity_id and s.deleted_at is null
			join stories st on st.id = s.story_id
			where r.entity_type = 'scene'
				and st.universe_id = ${universeId}
				and (r.created_at at time zone ${timezone})::date <= (now() at time zone ${timezone})::date - ${days}::int${storyFilter}
			order by r.entity_id, r.created_at desc
		) picked
	`);
	const yearRows = await db.execute(sql`
		select distinct ((r.created_at at time zone ${timezone})::date)::text as day
		from revisions r
		join scenes s on s.id = r.entity_id and s.deleted_at is null
		join stories st on st.id = s.story_id
		where r.entity_type = 'scene'
			and st.universe_id = ${universeId}
			and r.created_at >= now() - interval '366 days'${storyFilter}
	`);
	const todayResult = await db.execute(
		sql`select ((now() at time zone ${timezone})::date)::text as today`
	);
	const today = (todayResult.rows[0] as { today: string }).today;

	const net = dailyNetWords(
		windowRows.rows.map((row) => {
			const r = row as { entity_id: string; day: string; words: number };
			return { sceneId: r.entity_id, day: r.day, words: r.words };
		}),
		new Map(
			baselineRows.rows.map((row) => {
				const r = row as { entity_id: string; words: number };
				return [r.entity_id, r.words];
			})
		)
	);
	return {
		today,
		daily: dayAxis(today, days).map((day) => ({ day, words: net.get(day) ?? 0 })),
		streak: streaks(
			yearRows.rows.map((row) => (row as { day: string }).day),
			today
		)
	};
}

// The universe's relationships as web links; the entity heat rows double as
// the node list.
export async function relationshipLinks(db: Database, universeId: string): Promise<WebLink[]> {
	const rows = await db
		.select({
			id: entityRelationships.id,
			fromId: entityRelationships.fromId,
			toId: entityRelationships.toId,
			label: relationTypes.forwardLabel,
			category: relationTypes.category
		})
		.from(entityRelationships)
		.innerJoin(relationTypes, eq(entityRelationships.relationTypeId, relationTypes.id))
		.where(eq(entityRelationships.universeId, universeId));
	return rows;
}

/** True when the string names a timezone the runtime knows. */
export function isValidTimezone(timezone: string): boolean {
	try {
		new Intl.DateTimeFormat('en', { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
}
