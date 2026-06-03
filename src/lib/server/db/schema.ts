import {
	bigint,
	boolean,
	customType,
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
