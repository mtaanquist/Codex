import {
	bigint,
	boolean,
	customType,
	date,
	index,
	inet,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { EntityDetail, EntitySnapshot } from '../../entity-snapshot.ts';
import { NOTIFICATION_KINDS, type NotificationPayload } from '../../notifications.ts';
import { SCENE_STATUSES } from '../../scene-status.ts';

// Case-insensitive text, used for the public handle. The citext extension is
// created in the first migration.
const citext = customType<{ data: string }>({
	dataType() {
		return 'citext';
	}
});

export const users = pgTable('users', {
	id: uuid('id').primaryKey().defaultRandom(),
	email: text('email').unique().notNull(),
	// A new address awaiting confirmation; the live email only changes once the
	// emailed link is clicked, so a typo never locks anyone out.
	pendingEmail: text('pending_email'),
	displayName: text('display_name').notNull(),
	// Name to publish under when it differs from the display name; defaults to
	// the display name at render time when null.
	penName: text('pen_name'),
	// Public profile slug ('@handle'); null until a public profile is claimed.
	handle: citext('handle').unique(),
	// Short bio shown on the public profile shelf.
	bioMd: text('bio_md'),
	// External links for the public shelf: an ordered array of { label, url }.
	links: jsonb('links').notNull().default([]).$type<{ label: string; url: string }[]>(),
	// Whether the author is taking commissions, with an optional line saying
	// what they take on; both surface on the public shelf.
	commissionsOpen: boolean('commissions_open').notNull().default(false),
	commissionsMd: text('commissions_md'),
	// Account-level avatar image; references assets(id) (kind 'avatar'). Null
	// renders initials. Plain column, like stories.cover_asset_id.
	avatarAssetId: uuid('avatar_asset_id'),
	// Whether the '@handle' shelf is listed publicly.
	profilePublic: boolean('profile_public').notNull().default(false),
	// Admin grants this before a user may publish public pages.
	publicArchiveEnabled: boolean('public_archive_enabled').notNull().default(false),
	passwordHash: text('password_hash').notNull(),
	role: text('role', { enum: ['admin', 'user'] }).notNull(),
	// Reserved for future LLM integration; inert in v1.
	llmConfig: jsonb('llm_config').notNull().default({}),
	// Theme, content width, autocomplete mode, entity underline toggle, etc.
	preferences: jsonb('preferences').notNull().default({}),
	// The account's default print/PDF page setup; stories may override per
	// key through stories.page_setup.
	pageSetup: jsonb('page_setup').notNull().default({}),
	// References plans(id) in the schema design; the constraint is added once
	// the plans table exists. Null falls back to the default plan.
	planId: uuid('plan_id'),
	// Reserved for quota enforcement; not maintained in v1.
	storageUsedBytes: bigint('storage_used_bytes', { mode: 'number' }).notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	// Null until the email-confirm link is clicked.
	emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
	// Null until admin approves.
	approvedAt: timestamp('approved_at', { withTimezone: true }),
	// Set when an admin suspends the account; blocks sign-in without deleting.
	suspendedAt: timestamp('suspended_at', { withTimezone: true }),
	// Set when the user schedules deletion; a worker purges after the grace
	// window. The account is suspended for the duration so it cannot be used.
	deletionScheduledAt: timestamp('deletion_scheduled_at', { withTimezone: true }),
	// Updated on successful sign-in; useful for stale-account cleanup.
	lastLoginAt: timestamp('last_login_at', { withTimezone: true })
});

// Server-side session rows so sessions can be listed and revoked; the cookie
// carries the session id.
export const sessions = pgTable('sessions', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id')
		.references(() => users.id)
		.notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	// Set on sign-out or 'log out everywhere'.
	revokedAt: timestamp('revoked_at', { withTimezone: true }),
	userAgent: text('user_agent'),
	ip: inet('ip')
});

export const universes = pgTable(
	'universes',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: uuid('owner_id')
			.references(() => users.id)
			.notNull(),
		name: text('name').notNull(),
		// URL slug, unique within the owner's account. Generated from the name
		// at creation; renames leave it alone, editable in settings. Routes
		// accept the id too, so old links never break. The random default only
		// backstops direct inserts; the app always supplies a real slug.
		slug: text('slug')
			.notNull()
			.default(sql`substr(md5(random()::text), 1, 12)`),
		descriptionMd: text('description_md'),
		// The auto-created home for one-off stories outside any universe; at
		// most one per owner, made lazily the first time it is needed.
		standalone: boolean('standalone').notNull().default(false),
		// Soft delete: a deleted universe sits in the dashboard's trash for the
		// restore window, then the worker purges it for good. Null means live.
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		uniqueIndex('universes_owner_slug_idx').on(table.ownerId, table.slug),
		uniqueIndex('universes_one_standalone_idx')
			.on(table.ownerId)
			.where(sql`${table.standalone}`)
	]
);

export const stories = pgTable(
	'stories',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		universeId: uuid('universe_id')
			.references(() => universes.id)
			.notNull(),
		ownerId: uuid('owner_id')
			.references(() => users.id)
			.notNull(),
		title: text('title').notNull(),
		// URL slug, unique within the owner's account; same rules as
		// universes.slug.
		slug: text('slug')
			.notNull()
			.default(sql`substr(md5(random()::text), 1, 12)`),
		// Pen name shown on covers and public pages; defaults to the owner's
		// display name at render time when null.
		author: text('author'),
		brief: text('brief'),
		descriptionMd: text('description_md'),
		// Null if standalone or unordered.
		positionInSeries: integer('position_in_series'),
		visibility: text('visibility', { enum: ['private', 'unlisted', 'public'] })
			.notNull()
			.default('private'),
		// Author-flagged adult content; readers avoid it by default.
		isAdult: boolean('is_adult').notNull().default(false),
		// References assets(id) once that table exists (phase 4); null renders a
		// default cover from title and author.
		coverAssetId: uuid('cover_asset_id'),
		// Reserved for future LLM integration; inert in v1.
		llmConfig: jsonb('llm_config').notNull().default({}),
		// Per-story overrides of the owner's editor preferences; keys absent
		// here fall back to users.preferences at load time.
		preferences: jsonb('preferences').notNull().default({}),
		// Per-story overrides of the owner's print/PDF page setup; keys absent
		// here fall back to users.page_setup at render time.
		pageSetup: jsonb('page_setup').notNull().default({}),
		// Optional writing goals. A target length in words and a deadline date;
		// null means none. Progress shows on Insights.
		targetWords: integer('target_words'),
		deadline: date('deadline'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [uniqueIndex('stories_owner_slug_idx').on(table.ownerId, table.slug)]
);

// Chapters are organisational only; prose lives on scenes.
export const chapters = pgTable('chapters', {
	id: uuid('id').primaryKey().defaultRandom(),
	storyId: uuid('story_id')
		.references(() => stories.id)
		.notNull(),
	position: integer('position').notNull(),
	title: text('title'),
	summaryMd: text('summary_md'),
	// When the Assistant last generated this summary. Null means it was never
	// auto-generated (so a non-null summary here is the writer's own and is never
	// overwritten). See scenes.summary_generated_at.
	summaryGeneratedAt: timestamp('summary_generated_at', { withTimezone: true }),
	metadata: jsonb('metadata').notNull().default({}),
	updatedAt: timestamp('updated_at', { withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date())
});

export const scenes = pgTable(
	'scenes',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		storyId: uuid('story_id')
			.references(() => stories.id)
			.notNull(),
		// Nullable: orphan scenes are allowed before they have a chapter home.
		chapterId: uuid('chapter_id').references(() => chapters.id),
		// Null when orphan.
		positionInChapter: integer('position_in_chapter'),
		// Order across all scenes in the story; drives continuous-scroll views.
		globalPosition: integer('global_position').notNull(),
		title: text('title'),
		bodyMd: text('body_md').notNull().default(''),
		// References characters(id) and places(id) once those tables exist
		// (phase 3); plain columns until then, same pattern as users.plan_id.
		povCharacterId: uuid('pov_character_id'),
		locationId: uuid('location_id'),
		// Freeform, e.g. "Day 3 afternoon".
		storyTime: text('story_time'),
		// References characters.id once that table exists; GIN indexed.
		charactersPresent: uuid('characters_present').array(),
		status: text('status', { enum: SCENE_STATUSES }).notNull().default('draft'),
		// One line of what happens; shown in the sidebar and outline.
		summaryMd: text('summary_md'),
		// When the Assistant last generated summary_md. Null means the summary was
		// never auto-generated: a non-null summary with a null watermark is the
		// writer's own and the summary job never overwrites it. The job fills a
		// blank summary and refreshes one it generated when the body changed after
		// this watermark; the summary write preserves updated_at so it does not
		// look stale on the next run.
		summaryGeneratedAt: timestamp('summary_generated_at', { withTimezone: true }),
		// Updated on save.
		wordCount: integer('word_count').notNull().default(0),
		metadata: jsonb('metadata').notNull().default({}),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
		// When the mention index was last rebuilt for this scene. Null means never.
		// The reconcile sweep re-indexes any scene whose body or whose universe's
		// entities changed after this, so a dropped rebuild job self-heals.
		mentionsIndexedAt: timestamp('mentions_indexed_at', { withTimezone: true }),
		// Soft delete: a deleted scene sits in the story's trash until restored
		// or deleted for good. Null means live; every live query filters on it.
		deletedAt: timestamp('deleted_at', { withTimezone: true })
	},
	(table) => [
		index('scenes_characters_present_gin').using('gin', table.charactersPresent),
		// Trigram index behind the palette's body-text search; migration 0037
		// creates the pg_trgm extension it needs.
		index('scenes_body_trgm_idx').using('gin', table.bodyMd.op('gin_trgm_ops'))
	]
);

// Characters belong to the universe, not a story; per-story context layers on
// through character_story_notes.
export const characters = pgTable(
	'characters',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		universeId: uuid('universe_id')
			.references(() => universes.id)
			.notNull(),
		ownerId: uuid('owner_id')
			.references(() => users.id)
			.notNull(),
		name: text('name').notNull(),
		// Nicknames and variants; used for mention detection.
		aliases: text('aliases').array().notNull().default([]),
		// One or two lines; shown in hover popovers.
		summaryMd: text('summary_md'),
		bodyMd: text('body_md').notNull().default(''),
		// Set false for common-word names ("Will", "Art").
		autoDetectMentions: boolean('auto_detect_mentions').notNull().default(true),
		// Optional grouping; the category's colour drives the badge.
		categoryId: uuid('category_id').references(() => entityCategories.id),
		// Per-entity badge override: a palette colour, or an uploaded image
		// (the image wins). Both fall back to the category colour, then a name
		// hash, so an entity is never without a badge.
		badgeColor: text('badge_color'),
		badgeAssetId: uuid('badge_asset_id').references(() => assets.id),
		// Freeform quick details ("Status", "Age"), shown as the Details grid
		// and in the hover popover. Order is the author's.
		details: jsonb('details').$type<EntityDetail[]>().notNull().default([]),
		metadata: jsonb('metadata').notNull().default({}),
		// Original card data if imported (SillyTavern etc).
		importedFrom: jsonb('imported_from'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		// The palette search filters by owner and substring-matches the name.
		index('characters_owner_idx').on(table.ownerId),
		index('characters_name_trgm_idx').using('gin', table.name.op('gin_trgm_ops'))
	]
);

export const characterStoryNotes = pgTable(
	'character_story_notes',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		characterId: uuid('character_id')
			.references(() => characters.id)
			.notNull(),
		storyId: uuid('story_id')
			.references(() => stories.id)
			.notNull(),
		notesMd: text('notes_md').notNull().default(''),
		metadata: jsonb('metadata').notNull().default({}),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [unique('character_story_notes_unique').on(table.characterId, table.storyId)]
);

// User-defined groupings. Every lore entry belongs to one; characters and
// places may join one, which then drives their badge colour.
export const entityCategories = pgTable('entity_categories', {
	id: uuid('id').primaryKey().defaultRandom(),
	universeId: uuid('universe_id')
		.references(() => universes.id)
		.notNull(),
	ownerId: uuid('owner_id')
		.references(() => users.id)
		.notNull(),
	// "Lore", "Magical spells", "Factions" etc. New universes seed one "Lore".
	name: text('name').notNull(),
	// Hex or design token; used for sidebar dots and mention underlines.
	color: text('color'),
	sortOrder: integer('sort_order').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const loreEntries = pgTable(
	'lore_entries',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		universeId: uuid('universe_id')
			.references(() => universes.id)
			.notNull(),
		ownerId: uuid('owner_id')
			.references(() => users.id)
			.notNull(),
		categoryId: uuid('category_id')
			.references(() => entityCategories.id)
			.notNull(),
		title: text('title').notNull(),
		// Per-entity badge override: a palette colour, or an uploaded image
		// (the image wins). Both fall back to the category colour.
		badgeColor: text('badge_color'),
		badgeAssetId: uuid('badge_asset_id').references(() => assets.id),
		summaryMd: text('summary_md'),
		bodyMd: text('body_md').notNull().default(''),
		// In-editor search, mention detection, and (eventually) LLM context
		// injection.
		keywords: text('keywords').array().notNull().default([]),
		// Reserved for future LLM context injection; inert in v1.
		activationMode: text('activation_mode', { enum: ['always', 'keyword', 'manual'] })
			.notNull()
			.default('keyword'),
		autoDetectMentions: boolean('auto_detect_mentions').notNull().default(true),
		// Freeform quick details ("Status", "Age"), shown as the Details grid
		// and in the hover popover. Order is the author's.
		details: jsonb('details').$type<EntityDetail[]>().notNull().default([]),
		metadata: jsonb('metadata').notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		// The palette search filters by owner and substring-matches the title.
		index('lore_entries_owner_idx').on(table.ownerId),
		index('lore_entries_title_trgm_idx').using('gin', table.title.op('gin_trgm_ops'))
	]
);

export const loreStoryNotes = pgTable(
	'lore_story_notes',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		loreEntryId: uuid('lore_entry_id')
			.references(() => loreEntries.id)
			.notNull(),
		storyId: uuid('story_id')
			.references(() => stories.id)
			.notNull(),
		notesMd: text('notes_md').notNull().default(''),
		metadata: jsonb('metadata').notNull().default({}),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [unique('lore_story_notes_unique').on(table.loreEntryId, table.storyId)]
);

export const places = pgTable(
	'places',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		universeId: uuid('universe_id')
			.references(() => universes.id)
			.notNull(),
		ownerId: uuid('owner_id')
			.references(() => users.id)
			.notNull(),
		name: text('name').notNull(),
		// Nicknames and local names; the mention scan matches these too.
		aliases: text('aliases').array().notNull().default([]),
		// One or two lines; shown in hover popovers.
		summaryMd: text('summary_md'),
		bodyMd: text('body_md').notNull().default(''),
		// Set false for common-word names.
		autoDetectMentions: boolean('auto_detect_mentions').notNull().default(true),
		// Optional grouping; the category's colour drives the badge.
		categoryId: uuid('category_id').references(() => entityCategories.id),
		// Per-entity badge override: a palette colour, or an uploaded image
		// (the image wins). Both fall back to the category colour, then a name
		// hash.
		badgeColor: text('badge_color'),
		badgeAssetId: uuid('badge_asset_id').references(() => assets.id),
		// Freeform quick details ("Status", "Age"), shown as the Details grid
		// and in the hover popover. Order is the author's.
		details: jsonb('details').$type<EntityDetail[]>().notNull().default([]),
		metadata: jsonb('metadata').notNull().default({}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		// The palette search filters by owner and substring-matches the name.
		index('places_owner_idx').on(table.ownerId),
		index('places_name_trgm_idx').using('gin', table.name.op('gin_trgm_ops'))
	]
);

export const placeStoryNotes = pgTable(
	'place_story_notes',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		placeId: uuid('place_id')
			.references(() => places.id)
			.notNull(),
		storyId: uuid('story_id')
			.references(() => stories.id)
			.notNull(),
		notesMd: text('notes_md').notNull().default(''),
		metadata: jsonb('metadata').notNull().default({}),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [unique('place_story_notes_unique').on(table.placeId, table.storyId)]
);

// The author's explicit pick when two entities share a name or alias: in
// this story, this exact text means that entity. Detection orders the rest
// deterministically; a pin overrides it.
export const mentionPins = pgTable(
	'mention_pins',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		storyId: uuid('story_id')
			.references(() => stories.id, { onDelete: 'cascade' })
			.notNull(),
		// The matched text, exactly as it appears in prose.
		name: text('name').notNull(),
		targetType: text('target_type', { enum: ['character', 'place', 'lore_entry'] }).notNull(),
		targetId: uuid('target_id').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [unique('mention_pins_story_name').on(table.storyId, table.name)]
);

// Derived index of entity occurrences in prose. Rebuilt by the worker when a
// source's body changes: delete the source's rows, insert fresh ones. The
// polymorphic source/target columns carry no FKs by design.
export const entityMentions = pgTable(
	'entity_mentions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// 'scene' now; outline nodes and notes join later.
		sourceType: text('source_type').notNull(),
		sourceId: uuid('source_id').notNull(),
		targetType: text('target_type', { enum: ['character', 'place', 'lore_entry'] }).notNull(),
		targetId: uuid('target_id').notNull(),
		// Character offset in the source's body_md.
		position: integer('position').notNull(),
		// Snippet for previews and find-usages.
		surroundingText: text('surrounding_text').notNull()
	},
	(table) => [
		index('entity_mentions_target_idx').on(table.targetType, table.targetId),
		index('entity_mentions_source_idx').on(table.sourceType, table.sourceId)
	]
);

// Declared story membership: the explicit "this entity belongs to this
// story" signal, next to the derived one from mentions. Written when an
// entity is created while working in a story, or added to one by hand.
export const characterStoryMemberships = pgTable(
	'character_story_memberships',
	{
		characterId: uuid('character_id')
			.references(() => characters.id)
			.notNull(),
		storyId: uuid('story_id')
			.references(() => stories.id)
			.notNull(),
		declaredAt: timestamp('declared_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [primaryKey({ columns: [table.characterId, table.storyId] })]
);

export const placeStoryMemberships = pgTable(
	'place_story_memberships',
	{
		placeId: uuid('place_id')
			.references(() => places.id)
			.notNull(),
		storyId: uuid('story_id')
			.references(() => stories.id)
			.notNull(),
		declaredAt: timestamp('declared_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [primaryKey({ columns: [table.placeId, table.storyId] })]
);

// The vocabulary of declared relations. A seed migration provides the
// built-in library (universe_id null); universes can add their own, the
// same way entity categories work. Labels are never free-form on a
// relationship row: pick a type, put prose in the notes.
export const relationTypes = pgTable(
	'relation_types',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Null for built-ins, set for user-added types.
		universeId: uuid('universe_id').references(() => universes.id),
		key: text('key').notNull(),
		// "parent of"
		forwardLabel: text('forward_label').notNull(),
		// "child of"; null when bidirectional.
		reverseLabel: text('reverse_label'),
		// True for symmetric relations (sibling, friend, rival): one row,
		// forward label shown on both ends.
		bidirectional: boolean('bidirectional').notNull().default(false),
		fromType: text('from_type', { enum: ['character', 'place', 'lore_entry'] }).notNull(),
		toType: text('to_type', { enum: ['character', 'place', 'lore_entry'] }).notNull(),
		// 'family' | 'social' | 'geography'; groups the picker.
		category: text('category'),
		sortOrder: integer('sort_order'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// nulls-not-distinct so built-in keys (universe_id null) are unique too.
		unique('relation_types_universe_key').on(table.universeId, table.key).nullsNotDistinct()
	]
);

// User-declared relations between entities. Distinct from entity_mentions:
// relationships are entered, mentions are discovered. Directional relations
// store one row and render the reverse label on the target's page.
export const entityRelationships = pgTable(
	'entity_relationships',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		universeId: uuid('universe_id')
			.references(() => universes.id)
			.notNull(),
		ownerId: uuid('owner_id')
			.references(() => users.id)
			.notNull(),
		fromType: text('from_type', { enum: ['character', 'place', 'lore_entry'] }).notNull(),
		fromId: uuid('from_id').notNull(),
		toType: text('to_type', { enum: ['character', 'place', 'lore_entry'] }).notNull(),
		toId: uuid('to_id').notNull(),
		relationTypeId: uuid('relation_type_id')
			.references(() => relationTypes.id)
			.notNull(),
		// Null = universe-wide. Reserved for story-scoped overrides; no UI yet.
		storyId: uuid('story_id').references(() => stories.id),
		notesMd: text('notes_md'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		index('entity_relationships_from_idx').on(table.fromType, table.fromId),
		index('entity_relationships_to_idx').on(table.toType, table.toId),
		index('entity_relationships_scope_idx').on(table.universeId, table.storyId),
		// Backs the application duplicate check for universe-wide relationships,
		// so two concurrent identical requests cannot both insert. Partial on
		// story_id IS NULL: story-scoped overrides are unconstrained (no UI yet)
		// and the filter keeps NULL story ids from each comparing as distinct.
		uniqueIndex('entity_relationships_universe_unique')
			.on(table.relationTypeId, table.fromId, table.toId)
			.where(sql`${table.storyId} is null`)
	]
);

// Version history, polymorphic over everything with editable prose. A row
// per debounced save that changed the body (plus manual checkpoints), the
// newest first in the timeline. Snapshot-plus-diff compression is a later
// optimisation if the table grows large.
export const revisions = pgTable(
	'revisions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		entityType: text('entity_type', {
			enum: ['scene', 'character', 'place', 'lore_entry', 'chapter', 'note']
		}).notNull(),
		entityId: uuid('entity_id').notNull(),
		bodyMd: text('body_md').notNull(),
		// Structured fields captured alongside the body for character, place,
		// and lore revisions: name, aliases or keywords, summary, category,
		// details, and the relationship set. Null for scenes and outline nodes,
		// and for rows from before the column existed; those restore body-only.
		snapshot: jsonb('snapshot').$type<EntitySnapshot>(),
		// 'autosave' | 'checkpoint' | 'restore'; machine category, not prose.
		reason: text('reason'),
		// Optional checkpoint name given by the user.
		label: text('label'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('revisions_timeline_idx').on(table.entityType, table.entityId, table.createdAt.desc())
	]
);

// Freeform writer notes, scoped by whichever foreign key is populated: a
// note with only universeId set is universe-wide; one with storyId set is
// story-specific. chapterId and sceneId are reserved for finer attachment
// (not yet created from the UI). Distinct from the entity story-note
// overlays and from review comments. Revisions are recorded body-only under
// the 'note' entity type.
export const notes = pgTable(
	'notes',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: uuid('owner_id')
			.references(() => users.id)
			.notNull(),
		universeId: uuid('universe_id').references(() => universes.id),
		storyId: uuid('story_id').references(() => stories.id),
		chapterId: uuid('chapter_id').references(() => chapters.id),
		sceneId: uuid('scene_id').references(() => scenes.id),
		title: text('title'),
		bodyMd: text('body_md').notNull().default(''),
		pinned: boolean('pinned').notNull().default(false),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		index('notes_universe_idx').on(table.universeId),
		index('notes_story_idx').on(table.storyId)
	]
);

// A frozen, read-only edition of a story, served on the public reading
// pages. Snapshot, not live: in-progress drafts never appear, and the
// reader path reads only these rows.
export const publications = pgTable(
	'publications',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		storyId: uuid('story_id')
			.references(() => stories.id)
			.notNull(),
		ownerId: uuid('owner_id')
			.references(() => users.id)
			.notNull(),
		// Denormalised from users.handle for the reader path.
		handle: text('handle').notNull(),
		title: text('title').notNull(),
		author: text('author'),
		descriptionMd: text('description_md'),
		// Carried from stories.is_adult; the reader pages confirm before showing.
		isAdult: boolean('is_adult').notNull().default(false),
		// Frozen chapters and scenes for this edition, as markdown.
		content: jsonb('content').notNull(),
		// Optional, e.g. 'Edition 2'.
		versionLabel: text('version_label'),
		// Owner's choice: when true, readers can download the edition's EPUB and
		// PDF artifacts from the public story page.
		downloadsPublic: boolean('downloads_public').notNull().default(false),
		isCurrent: boolean('is_current').notNull().default(true),
		// Set by an admin takedown; hides the edition without deleting the source.
		removedAt: timestamp('removed_at', { withTimezone: true }),
		publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// At most one current edition per story; a concurrent re-publish that
		// would create a second hits this and rolls back.
		uniqueIndex('publications_one_current_per_story')
			.on(table.storyId)
			.where(sql`${table.isCurrent}`)
	]
);

// Assets a published edition references (inline images, plus the cover at
// publish time), captured when an edition is frozen. The reader serves an
// asset to anonymous visitors only when it appears here for a readable
// edition, so private prose's images cannot be fetched by guessing ids.
export const publicationAssets = pgTable(
	'publication_assets',
	{
		publicationId: uuid('publication_id')
			.references(() => publications.id)
			.notNull(),
		assetId: uuid('asset_id')
			.references(() => assets.id)
			.notNull()
	},
	(table) => [
		primaryKey({ columns: [table.publicationId, table.assetId] }),
		index('publication_assets_asset_idx').on(table.assetId)
	]
);

// Export files generated in the worker when an edition publishes (markdown
// zip, EPUB, PDF), stored in the asset bucket like release assets on a tag.
// Derived data: every row can be regenerated from the edition's frozen
// content, so rows simply replace on regeneration.
export const exportArtifacts = pgTable(
	'export_artifacts',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		publicationId: uuid('publication_id')
			.references(() => publications.id, { onDelete: 'cascade' })
			.notNull(),
		format: text('format', { enum: ['markdown', 'epub', 'pdf'] }).notNull(),
		// Key in the storage bucket; deterministic per publication and format so
		// regeneration overwrites in place.
		storageKey: text('storage_key').notNull(),
		filename: text('filename').notNull(),
		contentType: text('content_type').notNull(),
		byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [unique('export_artifacts_one_per_format').on(table.publicationId, table.format)]
);

// Uploaded files, stored in an S3-compatible bucket (separate from the
// backups bucket) and served through the app. The row is the source of
// truth for type and ownership; the object key is just the asset id under
// the configured prefix.
export const assets = pgTable('assets', {
	id: uuid('id').primaryKey().defaultRandom(),
	ownerId: uuid('owner_id')
		.references(() => users.id)
		.notNull(),
	// Scope; null for account-level images such as an avatar.
	universeId: uuid('universe_id').references(() => universes.id),
	// 'cover' | 'inline' | 'avatar' | ...
	kind: text('kind').notNull(),
	filename: text('filename').notNull(),
	contentType: text('content_type').notNull(),
	byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
	// Key in the storage bucket.
	storageKey: text('storage_key').notNull(),
	width: integer('width'),
	height: integer('height'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// A flagged spot in a scene to return to: a selection marked by hand, with
// a checkable state. Plain "TODO:" lines in prose are detected from the
// text instead and never get a row; deleting the line resolves them.
export const sceneMarkers = pgTable(
	'scene_markers',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		sceneId: uuid('scene_id')
			.references(() => scenes.id)
			.notNull(),
		ownerId: uuid('owner_id')
			.references(() => users.id)
			.notNull(),
		// 'note' and 'flag' are modelled for later; the UI creates 'todo'.
		kind: text('kind', { enum: ['todo', 'note', 'flag'] })
			.notNull()
			.default('todo'),
		// Character offsets into the scene body; the editor maps them through
		// edits and the autosave persists the moved positions.
		anchorStart: integer('anchor_start'),
		anchorEnd: integer('anchor_end'),
		// Optional note on the marker.
		bodyMd: text('body_md'),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [index('scene_markers_scene_idx').on(table.sceneId)]
);

// One row per off-site backup attempt, success or failure, so the admin
// page can show whether backups are actually happening. The bucket holds
// the dumps; this table holds the evidence.
export const backupRuns = pgTable('backup_runs', {
	id: uuid('id').primaryKey().defaultRandom(),
	// 'scheduled' | 'manual'
	trigger: text('trigger', { enum: ['scheduled', 'manual'] }).notNull(),
	// 'skipped' means the dump matched the previous one, so nothing was
	// uploaded; the run is still recorded so the cadence stays visible.
	status: text('status', { enum: ['running', 'ok', 'skipped', 'failed'] }).notNull(),
	// Object key in the bucket, set on success.
	objectKey: text('object_key'),
	sizeBytes: bigint('size_bytes', { mode: 'number' }),
	// sha256 of the dump, for skipping uploads when nothing changed.
	contentHash: text('content_hash'),
	error: text('error'),
	startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
	finishedAt: timestamp('finished_at', { withTimezone: true })
});

// Single-use tokens for email verification and password reset. The raw token
// is emailed; only its hash is stored.
export const authTokens = pgTable('auth_tokens', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id')
		.references(() => users.id)
		.notNull(),
	kind: text('kind', {
		enum: ['email_verify', 'password_reset', 'deletion_cancel', 'email_change']
	}).notNull(),
	tokenHash: text('token_hash').notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	consumedAt: timestamp('consumed_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Admin-minted sign-up codes. A valid code at sign-up sets approved_at
// immediately, skipping the manual approval queue; email verification still
// applies. Stored in clear (unlike auth tokens) so the admin can read a code
// back out and share it again.
export const inviteCodes = pgTable('invite_codes', {
	id: uuid('id').primaryKey().defaultRandom(),
	code: text('code').unique().notNull(),
	// Free-form note on who or what the code is for.
	label: text('label'),
	// Cleared (not blocked) if the minting account is ever deleted, so a code
	// outlives its creator and the purge path stays simple.
	createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
	maxUses: integer('max_uses').notNull().default(1),
	usedCount: integer('used_count').notNull().default(0),
	// Null never expires.
	expiresAt: timestamp('expires_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Instance-wide settings the admin manages from the panel (SMTP relay now).
// One row per setting key; the value is jsonb so each setting shapes its own.
// Any secret inside the value is stored encrypted (see crypto.ts).
export const appSettings = pgTable('app_settings', {
	key: text('key').primaryKey(),
	value: jsonb('value').notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// A user's TOTP authenticator enrolment, at most one per account. The secret is
// stored encrypted (see crypto.ts). The row exists from the moment setup begins;
// confirmed_at stays null until the first code is verified, so an abandoned
// setup never blocks sign-in. last_used_at backs replay protection.
export const userTotp = pgTable('user_totp', {
	userId: uuid('user_id')
		.primaryKey()
		.references(() => users.id),
	secret: text('secret').notNull(),
	confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
	lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
	// The highest TOTP step counter accepted so far; a code at or below it is a
	// replay and is refused. Backs single-use enforcement (RFC 6238 5.2).
	lastUsedStep: bigint('last_used_step', { mode: 'number' }),
	// A random nonce for the in-flight sign-in challenge: set when the password
	// step issues a challenge, cleared when the code is accepted, so a captured
	// challenge cookie cannot be replayed and a new password step invalidates
	// any earlier one.
	challenge: text('challenge'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// One-time recovery codes for when the authenticator is unavailable. Only the
// hash is stored; used_at marks a code spent so it cannot be replayed.
export const totpRecoveryCodes = pgTable(
	'totp_recovery_codes',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.references(() => users.id)
			.notNull(),
		codeHash: text('code_hash').notNull(),
		usedAt: timestamp('used_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('totp_recovery_codes_user_idx').on(table.userId)]
);

// Guest review: an author invites someone to review one story by magic link.
// Only the token's hash is stored; the guest may be an existing user or not
// and is never forced to create an account. Access is scoped to the one
// story, comment (and later suggest) only.
export const reviewInvitations = pgTable(
	'review_invitations',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		storyId: uuid('story_id')
			.references(() => stories.id)
			.notNull(),
		createdBy: uuid('created_by')
			.references(() => users.id)
			.notNull(),
		tokenHash: text('token_hash').unique().notNull(),
		// Optional note of who the link was sent to; nothing is emailed by Codex.
		email: text('email'),
		// false = comments only. Suggestions arrive in a later step; the column
		// is here from the start so invitations need no migration then.
		canSuggest: boolean('can_suggest').notNull().default(true),
		expiresAt: timestamp('expires_at', { withTimezone: true }),
		// Revoking cuts access; existing threads stay, attributed.
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('review_invitations_story_idx').on(table.storyId)]
);

// Who is reviewing under an invitation: a signed-in user (user_id set) or a
// guest who gave only a display name. Identity sticks to the browser via a
// signed cookie, so comments stay attributed across visits.
export const reviewers = pgTable(
	'reviewers',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		invitationId: uuid('invitation_id')
			.references(() => reviewInvitations.id)
			.notNull(),
		userId: uuid('user_id').references(() => users.id),
		displayName: text('display_name').notNull(),
		email: text('email'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
		// Email digests for guest reviewers: the watermark the next digest
		// reads from, and the opt-out the email's unsubscribe link sets.
		lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
		emailOptOutAt: timestamp('email_opt_out_at', { withTimezone: true })
	},
	(table) => [index('reviewers_invitation_idx').on(table.invitationId)]
);

// A comment thread on a scene: anchored to a character range in body_md
// (null anchors mean a whole-scene comment), pinned to the revision the
// range was placed against so later edits can re-anchor or flag it.
export const reviewThreads = pgTable(
	'review_threads',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		storyId: uuid('story_id')
			.references(() => stories.id)
			.notNull(),
		sceneId: uuid('scene_id')
			.references(() => scenes.id)
			.notNull(),
		anchorStart: integer('anchor_start'),
		anchorEnd: integer('anchor_end'),
		baseRevisionId: uuid('base_revision_id').references(() => revisions.id),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('review_threads_scene_idx').on(table.sceneId),
		index('review_threads_story_idx').on(table.storyId)
	]
);

// Messages in a thread. Exactly one of author_user_id / author_reviewer_id
// is set: the story's owner replies as a user, an invited guest as a reviewer.
export const reviewComments = pgTable(
	'review_comments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		threadId: uuid('thread_id')
			.references(() => reviewThreads.id)
			.notNull(),
		authorUserId: uuid('author_user_id').references(() => users.id),
		authorReviewerId: uuid('author_reviewer_id').references(() => reviewers.id),
		// The Assistant as a third author: both FK authors null, this true. The
		// display name is resolved live from the owner's assistant config, so a
		// rename relabels past comments on the fly.
		assistant: boolean('assistant').notNull().default(false),
		bodyMd: text('body_md').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [index('review_comments_thread_idx').on(table.threadId)]
);

// A proposed edit: replace [range_start, range_end) of the scene's body with
// the replacement text (equal offsets insert, an empty replacement deletes).
// Never applied directly: the author accepts or rejects one at a time, and
// accepting re-anchors the range against the current text first. Exactly one
// of author_user_id (the author reviewing their own story) / reviewer_id (a
// guest) is set, mirroring review_comments.
export const reviewSuggestions = pgTable(
	'review_suggestions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		storyId: uuid('story_id')
			.references(() => stories.id)
			.notNull(),
		sceneId: uuid('scene_id')
			.references(() => scenes.id)
			.notNull(),
		authorUserId: uuid('author_user_id').references(() => users.id),
		reviewerId: uuid('reviewer_id').references(() => reviewers.id),
		// The Assistant as a third author (both FK authors null, this true);
		// mirrors review_comments. The owner still accepts or rejects it.
		assistant: boolean('assistant').notNull().default(false),
		// The text the range was placed against.
		baseRevisionId: uuid('base_revision_id')
			.references(() => revisions.id)
			.notNull(),
		rangeStart: integer('range_start').notNull(),
		rangeEnd: integer('range_end').notNull(),
		replacement: text('replacement').notNull().default(''),
		status: text('status', { enum: ['pending', 'accepted', 'rejected'] })
			.notNull()
			.default('pending'),
		decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
		decidedAt: timestamp('decided_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('review_suggestions_scene_idx').on(table.sceneId),
		index('review_suggestions_story_idx').on(table.storyId)
	]
);

// In-app notifications behind the topbar bell. payload carries the display
// text and link target; in_app and email_wanted are stamped from the user's
// preference matrix at creation, and emailed_at when a digest sends it.
export const notifications = pgTable(
	'notifications',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.references(() => users.id)
			.notNull(),
		kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
		payload: jsonb('payload').$type<NotificationPayload>().notNull(),
		// Shown in the bell at all; false means the row only exists to feed
		// the email digest.
		inApp: boolean('in_app').notNull().default(true),
		readAt: timestamp('read_at', { withTimezone: true }),
		emailWanted: boolean('email_wanted').notNull().default(false),
		emailedAt: timestamp('emailed_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('notifications_user_idx').on(table.userId, table.createdAt.desc())]
);

// Registered passkeys (WebAuthn credentials), any number per account. The
// public key verifies sign-in assertions; sign_count backs clone detection.
// Sign-in is usernameless: the browser presents a discoverable credential and
// the row's user_id says whose it is.
export const webauthnCredentials = pgTable(
	'webauthn_credentials',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.references(() => users.id)
			.notNull(),
		// base64url of the raw credential id, as the authenticator reports it.
		credentialId: text('credential_id').unique().notNull(),
		publicKey: text('public_key').notNull(),
		signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),
		transports: text('transports').array(),
		// User label, e.g. 'phone' or 'security key'.
		name: text('name'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true })
	},
	(table) => [index('webauthn_credentials_user_idx').on(table.userId)]
);
