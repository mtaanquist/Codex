import {
	bigint,
	boolean,
	customType,
	inet,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
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
