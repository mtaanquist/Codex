import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	changeDisplayName,
	changePassword,
	claimHandle,
	listSessions,
	requestEmailChange,
	revokeOtherSessions,
	revokeOwnSession,
	saveProfile
} from '$lib/server/account';
import { DELETION_GRACE_DAYS, scheduleAccountDeletion } from '$lib/server/account-deletion';
import { revokeSession, SESSION_COOKIE } from '$lib/server/auth';
import { users } from '$lib/server/db/schema';
import { verifyPassword } from '$lib/server/password';
import { queueEmail } from '$lib/server/jobs';
import { savePreferences, userPreferences } from '$lib/server/preferences';
import { accountDeletionEmail, emailChangeEmail } from '$lib/server/email';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const sessionId = locals.session!.id;
	const [profile] = await db
		.select({
			handle: users.handle,
			bioMd: users.bioMd,
			profilePublic: users.profilePublic,
			publicArchiveEnabled: users.publicArchiveEnabled
		})
		.from(users)
		.where(eq(users.id, user.id));
	return {
		displayName: user.displayName,
		email: user.email,
		isAdmin: user.role === 'admin',
		origin: env.ORIGIN ?? url.origin,
		profile,
		preferences: await userPreferences(db, user.id),
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
	saveProfile: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await saveProfile(db, locals.user!.id, {
			bioMd: String(data.get('bioMd') ?? ''),
			profilePublic: data.get('profilePublic') === 'on'
		});
		if (!result.ok) return fail(400, { scope: 'profile', message: result.reason });
		return { scope: 'profile', saved: true };
	},
	claimHandle: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await claimHandle(db, locals.user!.id, String(data.get('handle') ?? ''));
		if (!result.ok) return fail(400, { scope: 'handle', message: result.reason });
		return { scope: 'handle', saved: true };
	},
	savePreferences: async ({ request, locals }) => {
		const data = await request.formData();
		const mode = String(data.get('entityAutocomplete') ?? '');
		const marks = String(data.get('continuousSceneMarks') ?? '');
		if (mode !== 'popup' && mode !== 'ghost' && mode !== 'off') {
			return fail(400, { scope: 'prefs', message: 'Pick an autocomplete mode.' });
		}
		if (marks !== 'shown' && marks !== 'hidden') {
			return fail(400, { scope: 'prefs', message: 'Pick a scene marks option.' });
		}
		await savePreferences(db, locals.user!.id, {
			entityAutocomplete: mode,
			continuousSceneMarks: marks
		});
		return { scope: 'prefs', saved: true };
	},
	signout: async ({ locals, cookies }) => {
		if (locals.session) await revokeSession(db, locals.session.id);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	},
	changeEmail: async ({ request, locals, url }) => {
		const data = await request.formData();
		const result = await requestEmailChange(
			db,
			locals.user!.id,
			String(data.get('password') ?? ''),
			String(data.get('newEmail') ?? '')
		);
		if (!result.ok) return fail(400, { scope: 'email', message: result.reason });
		const origin = env.ORIGIN ?? url.origin;
		await queueEmail(
			emailChangeEmail(result.newEmail, `${origin}/confirm-email-change?token=${result.token}`)
		);
		return { scope: 'email', sent: true };
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
