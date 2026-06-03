import {
	bigint,
	boolean,
	customType,
	index,
	inet,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid
} from 'drizzle-orm/pg-core';

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
	displayName: text('display_name').notNull(),
	// Public profile slug ('@handle'); null until a public profile is claimed.
	handle: citext('handle').unique(),
	// Short bio shown on the public profile shelf.
	bioMd: text('bio_md'),
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

export const universes = pgTable('universes', {
	id: uuid('id').primaryKey().defaultRandom(),
	ownerId: uuid('owner_id')
		.references(() => users.id)
		.notNull(),
	name: text('name').notNull(),
	descriptionMd: text('description_md'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date())
});

export const stories = pgTable('stories', {
	id: uuid('id').primaryKey().defaultRandom(),
	universeId: uuid('universe_id')
		.references(() => universes.id)
		.notNull(),
	ownerId: uuid('owner_id')
		.references(() => users.id)
		.notNull(),
	title: text('title').notNull(),
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
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date())
});

// Chapters are organisational only; prose lives on scenes.
export const chapters = pgTable('chapters', {
	id: uuid('id').primaryKey().defaultRandom(),
	storyId: uuid('story_id')
		.references(() => stories.id)
		.notNull(),
	position: integer('position').notNull(),
	title: text('title'),
	summaryMd: text('summary_md'),
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
		status: text('status', { enum: ['outline', 'draft', 'revised', 'final'] })
			.notNull()
			.default('draft'),
		// One line of what happens; shown in the sidebar and outline.
		summaryMd: text('summary_md'),
		// Updated on save.
		wordCount: integer('word_count').notNull().default(0),
		metadata: jsonb('metadata').notNull().default({}),
		updatedAt: timestamp('updated_at', { withTimezone: true })
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [index('scenes_characters_present_gin').using('gin', table.charactersPresent)]
);

// Characters belong to the universe, not a story; per-story context layers on
// through character_story_notes.
export const characters = pgTable('characters', {
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
	metadata: jsonb('metadata').notNull().default({}),
	// Original card data if imported (SillyTavern etc).
	importedFrom: jsonb('imported_from'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date())
});

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

export const places = pgTable('places', {
	id: uuid('id').primaryKey().defaultRandom(),
	universeId: uuid('universe_id')
		.references(() => universes.id)
		.notNull(),
	ownerId: uuid('owner_id')
		.references(() => users.id)
		.notNull(),
	name: text('name').notNull(),
	// One or two lines; shown in hover popovers.
	summaryMd: text('summary_md'),
	bodyMd: text('body_md').notNull().default(''),
	// Set false for common-word names.
	autoDetectMentions: boolean('auto_detect_mentions').notNull().default(true),
	metadata: jsonb('metadata').notNull().default({}),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true })
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date())
});

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

// Single-use tokens for email verification and password reset. The raw token
// is emailed; only its hash is stored.
export const authTokens = pgTable('auth_tokens', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: uuid('user_id')
		.references(() => users.id)
		.notNull(),
	kind: text('kind', { enum: ['email_verify', 'password_reset'] }).notNull(),
	tokenHash: text('token_hash').notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	consumedAt: timestamp('consumed_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
