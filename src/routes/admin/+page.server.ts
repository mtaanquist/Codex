import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	approveUser,
	listAllUsers,
	rejectUser,
	setUserArchive,
	setUserSuspended
} from '$lib/server/admin';
import { backupConfig, listRecentBackupRuns } from '$lib/server/backups';
import { queueBackup } from '$lib/server/jobs';
import { listPublications, takedownPublication } from '$lib/server/publish';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireAdmin(locals: App.Locals) {
	if (locals.user?.role !== 'admin') error(404, 'Not found');
}

export const load: PageServerLoad = async ({ locals }) => {
	requireAdmin(locals);
	return {
		users: await listAllUsers(db),
		published: await listPublications(db, 50),
		backupsConfigured: backupConfig() !== null,
		backupRuns: await listRecentBackupRuns(db, 5)
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
	unsuspend: async ({ request, locals }) => {
		requireAdmin(locals);
		return onUser(request, 'accounts', (id) => setUserSuspended(db, id, false));
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
	}
};
