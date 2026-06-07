import { error, fail, redirect } from '@sveltejs/kit';
import { isUuid } from '$lib/slug';
import { isSectionSlug } from './sections';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	approveUser,
	confirmUserEmail,
	instanceStats,
	listAllUsers,
	rejectUser,
	setUserArchive,
	setUserSuspended
} from '$lib/server/admin';
import {
	backupStorageView,
	effectiveBackupConfig,
	listRecentBackupRuns,
	saveBackupStorage
} from '$lib/server/backups';
import { applyBackupSchedule, queueAssetMigration, queueBackup } from '$lib/server/jobs';
import { probeS3 } from '$lib/server/s3-client';
import { createInviteCode, deleteInviteCode, listInviteCodes } from '$lib/server/invites';
import { listPublications, takedownPublication } from '$lib/server/publish';
import {
	saveSignupMode,
	saveSmtp,
	SIGNUP_MODES,
	signupMode,
	smtpView,
	type SignupMode
} from '$lib/server/settings';
import { secretsAvailable } from '$lib/server/crypto';
import { sendEmail } from '$lib/server/email';
import { adminCancelDeletion, purgeAccount } from '$lib/server/account-deletion';
import { disableTotp } from '$lib/server/two-factor';
import {
	assetMigrationResult,
	assetMigrationSource,
	assetStorageView,
	clearAssetMigrationSource,
	effectiveAssetConfig,
	s3AssetStore,
	saveAssetStorage
} from '$lib/server/assets';
import { eq } from 'drizzle-orm';
import { users } from '$lib/server/db/schema';
import pkg from '../../../../package.json';

// A compact uptime for the sidebar footer: minutes, then hours, then days.
function formatUptime(seconds: number): string {
	if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}

function requireAdmin(locals: App.Locals) {
	if (locals.user?.role !== 'admin') error(404, 'Not found');
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	requireAdmin(locals);
	// Older links carried the section as a query string; send them to the
	// section's own page.
	const legacy = url.searchParams.get('section');
	if (legacy && isSectionSlug(legacy)) redirect(308, `/admin/${legacy}`);
	// The overview rests on /admin itself; anything else must be a known slug.
	if (params.section !== undefined && !isSectionSlug(params.section)) error(404, 'Not found');
	return {
		meId: locals.user!.id,
		stats: await instanceStats(db),
		signup: await signupMode(db),
		users: await listAllUsers(db),
		inviteCodes: await listInviteCodes(db),
		published: await listPublications(db, 50),
		backupsConfigured: (await effectiveBackupConfig(db)) !== null,
		backupStorage: await backupStorageView(db),
		backupRuns: await listRecentBackupRuns(db, 5),
		assetStorage: await assetStorageView(db),
		assetMigrationPending: (await assetMigrationSource(db)) !== null,
		assetMigration: await assetMigrationResult(db),
		smtp: await smtpView(db),
		secretsAvailable: secretsAvailable(),
		version: pkg.version,
		uptime: formatUptime(process.uptime())
	};
};

// The S3 fields shared by the backup and asset storage forms.
function s3Input(data: FormData) {
	return {
		endpoint: String(data.get('endpoint') ?? ''),
		region: String(data.get('region') ?? ''),
		bucket: String(data.get('bucket') ?? ''),
		prefix: String(data.get('prefix') ?? ''),
		accessKeyId: String(data.get('accessKeyId') ?? ''),
		secretAccessKey: String(data.get('secretAccessKey') ?? '')
	};
}

// Reads a user id from the form and runs the action, returning a uniform
// result for the page. Keeps the per-action handlers to one line each.
async function onUser(request: Request, scope: string, run: (userId: string) => Promise<boolean>) {
	const data = await request.formData();
	const userId = String(data.get('userId') ?? '');
	if (!isUuid(userId) || !(await run(userId))) {
		return fail(400, { scope, message: 'That account could not be updated.' });
	}
	return { scope, done: true };
}

export const actions: Actions = {
	approve: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => approveUser(db, id));
	},
	confirmEmail: async ({ request, locals }) => {
		requireAdmin(locals);
		// Frees an account stuck behind a verification mail that never arrived.
		return onUser(request, 'accounts', (id) => confirmUserEmail(db, id));
	},
	reject: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => rejectUser(db, id));
	},
	enableArchive: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => setUserArchive(db, id, true));
	},
	disableArchive: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => setUserArchive(db, id, false));
	},
	suspend: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => setUserSuspended(db, id, true));
	},
	deleteAccount: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const userId = String(data.get('userId') ?? '');
		if (!isUuid(userId)) {
			return fail(400, { scope: 'accounts', message: 'That account could not be deleted.' });
		}
		// Never delete an admin or yourself from here.
		const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
		if (!target || target.role === 'admin' || userId === locals.user!.id) {
			return fail(400, { scope: 'accounts', message: 'That account cannot be deleted here.' });
		}
		const config = await effectiveAssetConfig(db);
		await purgeAccount(db, userId, config ? s3AssetStore(config) : null);
		return { scope: 'accounts', done: true };
	},
	unsuspend: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => setUserSuspended(db, id, false));
	},
	cancelDeletion: async ({ request, locals }) => {
		requireAdmin(locals);
		// Rescue an account from a pending self-deletion. Clears only the
		// schedule; a suspension stays its own decision.
		return onUser(request, 'accounts', (id) => adminCancelDeletion(db, id));
	},
	resetTotp: async ({ request, locals }) => {
		requireAdmin(locals);
		// Lockout recovery: clear a user's two-factor so they can sign in with
		// their password alone and set it up again.
		return onUser(request, 'accounts', async (id) => {
			await disableTotp(db, id);
			return true;
		});
	},
	saveSignup: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const mode = String(data.get('mode') ?? '');
		if (!SIGNUP_MODES.includes(mode as SignupMode)) {
			return fail(400, { scope: 'signup', message: 'Pick one of the sign-up options.' });
		}
		await saveSignupMode(db, mode as SignupMode);
		return { scope: 'signup', saved: true };
	},
	createInvite: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const maxUses = Number(data.get('maxUses') ?? 1);
		// Blank means the code never expires.
		const expiresRaw = String(data.get('expiresDays') ?? '').trim();
		const expiresDays = expiresRaw === '' ? 0 : Number(expiresRaw);
		if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
			return fail(400, {
				scope: 'invites',
				message: 'Uses must be a whole number from 1 to 1000.'
			});
		}
		if (!Number.isInteger(expiresDays) || expiresDays < 0 || expiresDays > 365) {
			return fail(400, {
				scope: 'invites',
				message: 'Leave expiry blank for a code that never expires, or use 1 to 365 days.'
			});
		}
		await createInviteCode(db, {
			createdBy: locals.user!.id,
			label: String(data.get('label') ?? ''),
			maxUses,
			expiresAt: expiresDays > 0 ? new Date(Date.now() + expiresDays * 86_400_000) : null
		});
		return { scope: 'invites', done: true };
	},
	deleteInvite: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const inviteId = String(data.get('inviteId') ?? '');
		if (!isUuid(inviteId) || !(await deleteInviteCode(db, inviteId))) {
			return fail(400, { scope: 'invites', message: 'That invite code does not exist.' });
		}
		return { scope: 'invites', done: true };
	},
	takedown: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const publicationId = String(data.get('publicationId') ?? '');
		if (!isUuid(publicationId) || !(await takedownPublication(db, publicationId))) {
			return fail(400, { scope: 'published', message: 'That edition does not exist.' });
		}
		return { scope: 'published', done: true };
	},
	runBackup: async ({ locals }) => {
		requireAdmin(locals);
		if (!(await effectiveBackupConfig(db))) {
			return fail(400, { scope: 'backups', message: 'Backups are not configured.' });
		}
		if (!(await queueBackup())) {
			return fail(500, { scope: 'backups', message: 'Could not queue the backup.' });
		}
		return { scope: 'backups', done: true };
	},
	saveBackups: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const result = await saveBackupStorage(db, {
			...s3Input(data),
			keepRecentHours: Number(data.get('keepRecentHours') ?? 48),
			keepDays: Number(data.get('keepDays') ?? 30)
		});
		if (!result.ok) return fail(400, { scope: 'backups', message: result.reason });
		// Make sure the worker's schedule exists without waiting for a restart.
		await applyBackupSchedule((await effectiveBackupConfig(db))?.cron ?? null);
		return { scope: 'backups', saved: true };
	},
	testBackups: async ({ locals }) => {
		requireAdmin(locals);
		const config = await effectiveBackupConfig(db);
		if (!config) {
			return fail(400, { scope: 'backups', message: 'Save the backup settings first.' });
		}
		const probe = await probeS3(config);
		if (!probe.ok) {
			return fail(400, {
				scope: 'backups',
				message: `Could not reach the bucket: ${probe.reason}`
			});
		}
		return { scope: 'backups', tested: true };
	},
	saveAssets: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const result = await saveAssetStorage(db, s3Input(data));
		if (!result.ok) return fail(400, { scope: 'storage', message: result.reason });
		return { scope: 'storage', saved: true };
	},
	testAssets: async ({ locals }) => {
		requireAdmin(locals);
		const config = await effectiveAssetConfig(db);
		if (!config) {
			return fail(400, { scope: 'storage', message: 'Save the asset storage settings first.' });
		}
		const probe = await probeS3(config);
		if (!probe.ok) {
			return fail(400, {
				scope: 'storage',
				message: `Could not reach the bucket: ${probe.reason}`
			});
		}
		return { scope: 'storage', tested: true };
	},
	migrateAssets: async ({ locals }) => {
		requireAdmin(locals);
		if (!(await assetMigrationSource(db))) {
			return fail(400, { scope: 'storage', message: 'There is nothing to copy.' });
		}
		if (!(await queueAssetMigration())) {
			return fail(500, { scope: 'storage', message: 'Could not queue the copy.' });
		}
		return { scope: 'storage', migrating: true };
	},
	dismissMigration: async ({ locals }) => {
		requireAdmin(locals);
		await clearAssetMigrationSource(db);
		return { scope: 'storage', done: true };
	},
	saveSmtp: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const result = await saveSmtp(db, {
			host: String(data.get('host') ?? ''),
			port: Number(data.get('port') ?? 587),
			secure: data.get('secure') === 'on',
			user: String(data.get('user') ?? ''),
			from: String(data.get('from') ?? ''),
			password: String(data.get('password') ?? '')
		});
		if (!result.ok) return fail(400, { scope: 'smtp', message: result.reason });
		return { scope: 'smtp', saved: true };
	},
	testEmail: async ({ locals }) => {
		requireAdmin(locals);
		// Sent inline (not queued) so the result is reported back to the admin.
		try {
			await sendEmail(db, {
				to: locals.user!.email,
				subject: 'Codex test email',
				text: 'This is a test email from your Codex instance. Email is working.'
			});
		} catch (err) {
			return fail(400, {
				scope: 'smtp',
				message: `Could not send: ${err instanceof Error ? err.message : 'unknown error'}`
			});
		}
		return { scope: 'smtp', tested: true };
	}
};
