import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	changeDisplayName,
	changePassword,
	listSessions,
	revokeOtherSessions,
	revokeOwnSession
} from '$lib/server/account';
import { DELETION_GRACE_DAYS, scheduleAccountDeletion } from '$lib/server/account-deletion';
import { SESSION_COOKIE } from '$lib/server/auth';
import { users } from '$lib/server/db/schema';
import { verifyPassword } from '$lib/server/password';
import { queueEmail } from '$lib/server/jobs';
import { accountDeletionEmail } from '$lib/server/email';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const sessionId = locals.session!.id;
	return {
		displayName: user.displayName,
		email: user.email,
		sessions: await listSessions(db, user.id, sessionId),
		graceDays: DELETION_GRACE_DAYS
	};
};

export const actions: Actions = {
	updateName: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await changeDisplayName(
			db,
			locals.user!.id,
			String(data.get('displayName') ?? '')
		);
		if (!result.ok) return fail(400, { scope: 'name', message: result.reason });
		return { scope: 'name', saved: true };
	},
	changePassword: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await changePassword(
			db,
			locals.user!.id,
			locals.session!.id,
			String(data.get('currentPassword') ?? ''),
			String(data.get('newPassword') ?? '')
		);
		if (!result.ok) return fail(400, { scope: 'password', message: result.reason });
		return { scope: 'password', saved: true };
	},
	revokeSession: async ({ request, locals }) => {
		const data = await request.formData();
		const sessionId = String(data.get('sessionId') ?? '');
		if (sessionId === locals.session!.id) {
			return fail(400, { scope: 'sessions', message: 'Use sign out to end your current session.' });
		}
		await revokeOwnSession(db, locals.user!.id, sessionId);
		return { scope: 'sessions', saved: true };
	},
	revokeOthers: async ({ locals }) => {
		await revokeOtherSessions(db, locals.user!.id, locals.session!.id);
		return { scope: 'sessions', saved: true };
	},
	deleteAccount: async ({ request, locals, url, cookies }) => {
		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		const [account] = await db
			.select({ passwordHash: users.passwordHash })
			.from(users)
			.where(eq(users.id, locals.user!.id));
		if (!account || !(await verifyPassword(account.passwordHash, password))) {
			return fail(400, { scope: 'delete', message: 'That is not your password.' });
		}
		const token = await scheduleAccountDeletion(db, locals.user!.id);
		const origin = env.ORIGIN ?? url.origin;
		await queueEmail(
			accountDeletionEmail(
				locals.user!.email,
				`${origin}/cancel-deletion?token=${token}`,
				DELETION_GRACE_DAYS
			)
		);
		// The account is now deactivated; end the current session.
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
