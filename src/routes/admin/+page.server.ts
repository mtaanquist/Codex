import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	approveUser,
	instanceStats,
	listAllUsers,
	rejectUser,
	setUserArchive,
	setUserSuspended
} from '$lib/server/admin';
import { backupConfig, listRecentBackupRuns } from '$lib/server/backups';
import { queueBackup } from '$lib/server/jobs';
import { listPublications, takedownPublication } from '$lib/server/publish';
import { saveSmtp, smtpView } from '$lib/server/settings';
import { secretsAvailable } from '$lib/server/crypto';
import { sendEmail } from '$lib/server/email';
import { purgeAccount } from '$lib/server/account-deletion';
import { disableTotp } from '$lib/server/two-factor';
import { assetConfig, s3AssetStore } from '$lib/server/assets';
import { eq } from 'drizzle-orm';
import { users } from '$lib/server/db/schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireAdmin(locals: App.Locals) {
	if (locals.user?.role !== 'admin') error(404, 'Not found');
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);
	return {
		meId: locals.user!.id,
		stats: await instanceStats(db),
		users: await listAllUsers(db),
		published: await listPublications(db, 50),
		backupsConfigured: backupConfig() !== null,
		backupRuns: await listRecentBackupRuns(db, 5),
		smtp: await smtpView(db),
		secretsAvailable: secretsAvailable()
	};
};

// Reads a user id from the form and runs the action, returning a uniform
// result for the page. Keeps the per-action handlers to one line each.
async function onUser(request: Request, scope: string, run: (userId: string) => Promise<boolean>) {
	const data = await request.formData();
	const userId = String(data.get('userId') ?? '');
	if (!UUID.test(userId) || !(await run(userId))) {
		return fail(400, { scope, message: 'That account could not be updated.' });
	}
	return { scope, done: true };
}

export const actions: Actions = {
	approve: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => approveUser(db, id));
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
		if (!UUID.test(userId)) {
			return fail(400, { scope: 'accounts', message: 'That account could not be deleted.' });
		}
		// Never delete an admin or yourself from here.
		const [target] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
		if (!target || target.role === 'admin' || userId === locals.user!.id) {
			return fail(400, { scope: 'accounts', message: 'That account cannot be deleted here.' });
		}
		const config = assetConfig();
		await purgeAccount(db, userId, config ? s3AssetStore(config) : null);
		return { scope: 'accounts', done: true };
	},
	unsuspend: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => setUserSuspended(db, id, false));
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
	takedown: async ({ request, locals }) => {
		requireAdmin(locals);
		const data = await request.formData();
		const publicationId = String(data.get('publicationId') ?? '');
		if (!UUID.test(publicationId) || !(await takedownPublication(db, publicationId))) {
			return fail(400, { scope: 'published', message: 'That edition does not exist.' });
		}
		return { scope: 'published', done: true };
	},
	runBackup: async ({ locals }) => {
		requireAdmin(locals);
		if (!backupConfig()) {
			return fail(400, { scope: 'backups', message: 'Backups are not configured.' });
		}
		if (!(await queueBackup())) {
			return fail(500, { scope: 'backups', message: 'Could not queue the backup.' });
		}
		return { scope: 'backups', done: true };
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
