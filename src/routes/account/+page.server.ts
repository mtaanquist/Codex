import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import {
	changePassword,
	claimHandle,
	listSessions,
	parseLinks,
	requestEmailChange,
	revokeOtherSessions,
	revokeOwnSession,
	saveIdentity,
	saveProfile,
	verifyAccountPassword
} from '$lib/server/account';
import { assetConfig, clearUserAvatar, s3AssetStore, setUserAvatar } from '$lib/server/assets';
import { DELETION_GRACE_DAYS, scheduleAccountDeletion } from '$lib/server/account-deletion';
import { revokeSession, SESSION_COOKIE } from '$lib/server/auth';
import { users } from '$lib/server/db/schema';
import { verifyPassword } from '$lib/server/password';
import { queueEmail } from '$lib/server/jobs';
import { savePreferences, userPreferences } from '$lib/server/preferences';
import { accountDeletionEmail, emailChangeEmail } from '$lib/server/email';
import { isAccentColor, isTheme, normaliseAccent } from '$lib/appearance';
import { secretsAvailable } from '$lib/server/crypto';
import {
	beginEnrollment,
	confirmEnrollment,
	disableTotp,
	pendingEnrollment,
	recoveryCodesRemaining,
	regenerateRecoveryCodes,
	totpStatus
} from '$lib/server/two-factor';
import { listPasskeys, removePasskey } from '$lib/server/passkeys';
import QRCode from 'qrcode';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const sessionId = locals.session!.id;
	const [profile] = await db
		.select({
			handle: users.handle,
			penName: users.penName,
			bioMd: users.bioMd,
			links: users.links,
			commissionsOpen: users.commissionsOpen,
			commissionsMd: users.commissionsMd,
			avatarAssetId: users.avatarAssetId,
			profilePublic: users.profilePublic,
			publicArchiveEnabled: users.publicArchiveEnabled
		})
		.from(users)
		.where(eq(users.id, user.id));

	const totp = await totpStatus(db, user.id);
	const totpAvailable = secretsAvailable();
	// While setup is pending, hand the screen the secret and a QR to redraw.
	let totpSetup: { secret: string; otpauthUri: string; qr: string } | null = null;
	if (totp.status === 'pending' && totpAvailable) {
		const pending = await pendingEnrollment(db, user.id, user.email);
		if (pending) totpSetup = { ...pending, qr: await QRCode.toDataURL(pending.otpauthUri) };
	}

	return {
		displayName: user.displayName,
		email: user.email,
		assetsConfigured: assetConfig() !== null,
		isAdmin: user.role === 'admin',
		origin: env.ORIGIN ?? url.origin,
		profile,
		preferences: await userPreferences(db, user.id),
		sessions: await listSessions(db, user.id, sessionId),
		graceDays: DELETION_GRACE_DAYS,
		twoFactor: {
			status: totp.status,
			confirmedAt: totp.confirmedAt,
			available: totpAvailable,
			recoveryRemaining: totp.status === 'on' ? await recoveryCodesRemaining(db, user.id) : 0
		},
		totpSetup,
		passkeys: await listPasskeys(db, user.id),
		passkeysAvailable: secretsAvailable()
	};
};

export const actions: Actions = {
	updateName: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await saveIdentity(db, locals.user!.id, {
			displayName: String(data.get('displayName') ?? ''),
			penName: String(data.get('penName') ?? '')
		});
		if (!result.ok) return fail(400, { scope: 'name', message: result.reason });
		return { scope: 'name', saved: true };
	},
	saveProfile: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await saveProfile(db, locals.user!.id, {
			bioMd: String(data.get('bioMd') ?? ''),
			profilePublic: data.get('profilePublic') === 'on',
			links: parseLinks(String(data.get('links') ?? '')),
			commissionsOpen: data.get('commissionsOpen') === 'on',
			commissionsMd: String(data.get('commissionsMd') ?? '')
		});
		if (!result.ok) return fail(400, { scope: 'profile', message: result.reason });
		return { scope: 'profile', saved: true };
	},
	uploadAvatar: async ({ request, locals }) => {
		const config = assetConfig();
		if (!config) {
			return fail(503, { scope: 'avatar', message: 'Image uploads are not configured.' });
		}
		const data = await request.formData();
		const file = data.get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { scope: 'avatar', message: 'Choose an image to upload.' });
		}
		const result = await setUserAvatar(db, s3AssetStore(config), config, locals.user!.id, {
			filename: file.name,
			contentType: file.type,
			bytes: Buffer.from(await file.arrayBuffer())
		});
		if (!result.ok) return fail(400, { scope: 'avatar', message: result.reason });
		return { scope: 'avatar', saved: true };
	},
	removeAvatar: async ({ locals }) => {
		const config = assetConfig();
		if (config) await clearUserAvatar(db, s3AssetStore(config), locals.user!.id);
		return { scope: 'avatar', saved: true };
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
	saveAppearance: async ({ request, locals }) => {
		const data = await request.formData();
		const theme = String(data.get('theme') ?? '');
		const accent = String(data.get('accent') ?? '');
		if (!isTheme(theme)) return fail(400, { scope: 'appearance', message: 'Pick a theme.' });
		if (!isAccentColor(accent)) {
			return fail(400, { scope: 'appearance', message: 'Pick a valid accent colour.' });
		}
		await savePreferences(db, locals.user!.id, { theme, accent: normaliseAccent(accent) });
		return { scope: 'appearance', saved: true };
	},
	startTotp: async ({ locals }) => {
		if (!secretsAvailable()) {
			return fail(503, {
				scope: 'totp',
				message: 'Two-factor authentication is not configured on this instance.'
			});
		}
		const result = await beginEnrollment(db, locals.user!.id, locals.user!.email);
		if (!result.ok) return fail(400, { scope: 'totp', message: result.reason });
		// The load now sees a pending enrolment and renders the setup step.
		return { scope: 'totp', setupStarted: true };
	},
	confirmTotp: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await confirmEnrollment(db, locals.user!.id, String(data.get('code') ?? ''));
		if (!result.ok) return fail(400, { scope: 'totp', message: result.reason });
		return { scope: 'totp', recoveryCodes: result.recoveryCodes };
	},
	cancelTotp: async ({ locals }) => {
		// Only clears an unconfirmed setup; the button is hidden once it is on.
		await disableTotp(db, locals.user!.id);
		return { scope: 'totp', cancelled: true };
	},
	disableTotp: async ({ request, locals }) => {
		const data = await request.formData();
		if (!(await verifyAccountPassword(db, locals.user!.id, String(data.get('password') ?? '')))) {
			return fail(400, { scope: 'totp', message: 'That password is not right.' });
		}
		await disableTotp(db, locals.user!.id);
		return { scope: 'totp', disabled: true };
	},
	regenerateRecovery: async ({ request, locals }) => {
		const data = await request.formData();
		if (!(await verifyAccountPassword(db, locals.user!.id, String(data.get('password') ?? '')))) {
			return fail(400, { scope: 'totp', message: 'That password is not right.' });
		}
		const codes = await regenerateRecoveryCodes(db, locals.user!.id);
		if (!codes) return fail(400, { scope: 'totp', message: 'Two-factor authentication is off.' });
		return { scope: 'totp', recoveryCodes: codes };
	},
	removePasskey: async ({ request, locals }) => {
		const data = await request.formData();
		// Removing a sign-in credential is guarded by the password, the same as
		// turning two-factor off: a borrowed session must not weaken sign-in.
		if (!(await verifyAccountPassword(db, locals.user!.id, String(data.get('password') ?? '')))) {
			return fail(400, { scope: 'passkeys', message: 'That password is not right.' });
		}
		const id = String(data.get('passkeyId') ?? '');
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
			!(await removePasskey(db, locals.user!.id, id))
		) {
			return fail(400, { scope: 'passkeys', message: 'That passkey could not be removed.' });
		}
		return { scope: 'passkeys', removed: true };
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
