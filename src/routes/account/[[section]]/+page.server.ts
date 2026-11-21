import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { publicOrigin } from '#lib/server/origin';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db';
import { isUuid } from '#lib/slug';
import {
	changePassword,
	claimHandle,
	enableOwnPublishing,
	setPenNameIfUnset,
	listSessions,
	parseLinks,
	requestEmailChange,
	revokeOtherSessions,
	revokeOwnSession,
	saveIdentity,
	saveProfile,
	verifyAccountPassword
} from '#lib/server/account';
import {
	effectiveAssetConfig,
	clearUserAvatar,
	s3AssetStore,
	setUserAvatar
} from '#lib/server/assets';
import { DELETION_GRACE_DAYS, scheduleAccountDeletion } from '#lib/server/account-deletion';
import { SESSION_COOKIE } from '#lib/server/auth';
import { users } from '#lib/server/db/schema';
import { queueEmail, queueUserExport } from '#lib/server/jobs';
import { listUserExports, markExportFailed, requestExport } from '#lib/server/user-exports';
import { exportLimit, uploadLimit } from '#lib/server/rate-limit';
import { saveLibraryView, savePreferences, userPreferences } from '#lib/server/preferences';
import { createUserInvite, deleteUserInviteCode, listUserInviteCodes } from '#lib/server/invites';
import {
	accountLlmView,
	scopeChosenModels,
	ASSISTANT_ROLES,
	EFFORT_LEVELS,
	type EffortLevel,
	type ExtraParams,
	type TuningMap,
	saveAccountLlmConfig,
	CACHE_TTLS,
	type CacheTtl,
	type ModelContextMap,
	type ModelPricing,
	type ModelMap,
	type SaveResult,
	MAX_TOOL_BUDGET,
	TOOL_PROFILES,
	type ToolProfile
} from '#lib/server/llm/config';
import { discoverModels, testAccountConnection } from '#lib/server/llm/models';
import {
	normaliseProviderId,
	PROVIDER_PRESETS,
	type ProviderId
} from '#lib/server/llm/providers/presets';
import { MODEL_GUIDE, ROLE_TIER, suggestedModel } from '#lib/server/llm/providers/model-guide';
import { resolveRoleModel } from '#lib/assistant-tuning';
import { recentAssistantUsage } from '#lib/server/llm/usage';
import { normalisePersona, PERSONAS } from '#lib/server/llm/prompts/persona';
import { saveUserPageSetup, userPageSetup } from '#lib/server/page-setup';
import {
	clampLineSpacingCm,
	isLineSpacing,
	isPageFont,
	normalisePageSetup,
	sanitiseFontName
} from '#lib/page-setup';
import { isAccentColor, isConcreteTheme, isTheme, normaliseAccent } from '#lib/appearance';
import { ADMIN_KINDS, NOTIFICATION_KINDS, type NotificationMatrix } from '#lib/notifications';
import { secretsAvailable } from '#lib/server/crypto';
import {
	beginEnrollment,
	cancelPendingEnrollment,
	confirmEnrollment,
	disableTotp,
	pendingEnrollment,
	recoveryCodesRemaining,
	regenerateRecoveryCodes,
	totpStatus,
	verifyUserTotp
} from '#lib/server/two-factor';
import { listPasskeys, removePasskey } from '#lib/server/passkeys';
import { reauthLimit } from '#lib/server/reauth';
import QRCode from 'qrcode';
import { formText } from '#lib/server/validation';
import {
	createPersonalToken,
	listGrants,
	listPersonalTokens,
	revokeGrant
} from '#lib/server/mcp/oauth';
import { PERSONAL_TOKEN_DEFAULT_DAYS, PERSONAL_TOKEN_EXPIRY_DAYS } from '#lib/server/mcp/constants';
import {
	mcpAccountEnabled,
	mcpInstanceEnabled,
	setMcpAccountEnabled
} from '#lib/server/mcp/settings';

// The actions that re-verify the password share one throttle (see reauthLimit),
// so a borrowed session cannot brute-force the password through them. Passkey
// registration is gated the same way in its own API endpoint.
function reauthGuard(userId: string, scope: string) {
	const limit = reauthLimit(userId);
	if (limit.allowed) return null;
	const minutes = Math.ceil(limit.retryAfterSeconds / 60);
	return fail(429, {
		scope,
		message: `Too many attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
	});
}

// Opening the account to outside programs (turning access on, making a
// personal access token) hands out a credential that outlives the session, so
// it asks who is there: the password, and the authenticator code when
// two-factor is on. Returns the failure to answer with, or null to go on.
async function confirmIdentity(userId: string, data: FormData, scope: string) {
	const limited = reauthGuard(userId, scope);
	if (limited) return limited;
	if (!(await verifyAccountPassword(db, userId, formText(data, 'password')))) {
		return fail(400, { scope, message: 'That password is not right.' });
	}
	if ((await totpStatus(db, userId)).status === 'on') {
		const code = formText(data, 'code').replace(/\s+/g, '');
		if (!(await verifyUserTotp(db, userId, code))) {
			return fail(400, {
				scope,
				message:
					'That code is not right. Enter the current code from your authenticator app. Each code works once, so if you have just used this one, wait for the next.'
			});
		}
	}
	return null;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	// Profile rests on /account itself; the other sections have their own page.
	if (
		params.section !== undefined &&
		![
			'security',
			'display',
			'editor',
			'notifications',
			'pagesetup',
			'assistant',
			'invites',
			'apps'
		].includes(params.section)
	)
		error(404, 'Not found');
	const user = locals.user!;
	// Connected apps exists only while the instance allows outside apps.
	const externalAccessAvailable = await mcpInstanceEnabled(db);
	if (params.section === 'apps' && !externalAccessAvailable) error(404, 'Not found');
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
		assetsConfigured: (await effectiveAssetConfig(db)) !== null,
		isAdmin: user.role === 'admin',
		origin: publicOrigin(url),
		profile,
		preferences: await userPreferences(db, user.id),
		pageSetup: await userPageSetup(db, user.id),
		assistant: await accountLlmView(db, user.id),
		// Models chosen only on a universe or a story, which need a context
		// window and a price like the account's own.
		scopeModels: await scopeChosenModels(db, user.id),
		toolCallLimitMax: MAX_TOOL_BUDGET,
		// The usage log pages through ?usage=N (zero-based, newest first).
		assistantUsage: await recentAssistantUsage(
			db,
			user.id,
			Number(url.searchParams.get('usage')) || 0
		),
		// The provider presets and tone presets, sent through so the client need
		// not import the server-only modules.
		providers: PROVIDER_PRESETS.map((p) => ({
			id: p.id,
			label: p.label,
			baseUrl: p.baseUrl,
			keyHint: p.keyHint,
			docsUrl: p.docsUrl
		})),
		// Which model to suggest for each role, on every provider.
		modelGuide: { tiers: ROLE_TIER, providers: MODEL_GUIDE },
		personas: PERSONAS.map((p) => ({ id: p.id, label: p.label, description: p.description })),
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
		passkeysAvailable: secretsAvailable(),
		exports: await listUserExports(db, user.id, { scope: 'account' }),
		// The Invites section: how many codes the admin has granted, and the
		// ones already generated. The section hides while both are empty.
		inviteAllowance: await userInviteAllowance(db, user.id),
		myInvites: await listUserInviteCodes(db, user.id),
		externalAccess: {
			available: externalAccessAvailable,
			enabled: await mcpAccountEnabled(db, user.id),
			apps: externalAccessAvailable ? await listGrants(db, user.id) : [],
			tokens: externalAccessAvailable ? await listPersonalTokens(db, user.id) : [],
			tokenExpiryDays: [...PERSONAL_TOKEN_EXPIRY_DAYS],
			tokenDefaultDays: PERSONAL_TOKEN_DEFAULT_DAYS,
			// Making a token asks for a code as well when two-factor is on.
			needsCode: totp.status === 'on'
		}
	};
};

async function userInviteAllowance(dbc: typeof db, userId: string): Promise<number> {
	const [row] = await dbc
		.select({ allowance: users.inviteAllowance })
		.from(users)
		.where(eq(users.id, userId));
	return row?.allowance ?? 0;
}

// An extra-parameters box holds a JSON object, or nothing at all: a blank box
// clears what is stored, and anything unreadable is refused rather than saved
// as a setting that would never take effect.
function paramsField(raw: string): ExtraParams | 'invalid' {
	const text = raw.trim();
	if (!text) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return 'invalid';
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
	return parsed as ExtraParams;
}

// Prices are typed in dollars per million tokens and stored per token.
const TOKENS_PER_MILLION = 1_000_000;
const PARAMS_MESSAGE = 'Extra settings must be a JSON object, like {"top_p": 0.9}.';

// The Assistant section saves in pieces (identity, endpoint, models, the kill
// switch), each its own button. saveAccountLlmConfig replaces the whole config
// from its input, so a partial save first reads the current view and overlays
// only the changed fields; a blank api key keeps the stored one. A provider
// switch resets what belonged to the old one (see saveAccountLlmConfig).
async function patchAssistant(
	userId: string,
	patch: Partial<{
		enabled: boolean;
		assistantName: string;
		persona: string;
		provider: ProviderId;
		endpoint: string;
		apiKey: string;
		models: ModelMap;
		tuning: TuningMap;
		extraParams: ExtraParams;
		webSearch: boolean;
		toolProfile: ToolProfile;
		toolCallBudget: number;
		modelContextManual: ModelContextMap;
		modelPricingManual: ModelPricing;
		cacheTtl: CacheTtl;
		spendCapUsd: number | null;
		spendWarnUsd: number | null;
	}>
): Promise<SaveResult> {
	const current = await accountLlmView(db, userId);
	return saveAccountLlmConfig(db, userId, {
		enabled: patch.enabled ?? current.enabled,
		assistantName: patch.assistantName ?? current.assistantName,
		persona: normalisePersona(patch.persona ?? current.persona),
		// Left out unless this save is the provider picker's, so a save from
		// another form cannot undo a switch that landed after it read the config.
		provider: patch.provider,
		endpoint: patch.endpoint ?? current.endpoint,
		apiKey: patch.apiKey ?? '',
		models: patch.models ?? current.models,
		tuning: patch.tuning ?? current.tuning,
		extraParams: patch.extraParams,
		webSearch: patch.webSearch,
		toolCallBudget: patch.toolCallBudget,
		toolProfile: patch.toolProfile ?? current.toolProfile,
		modelContextManual: patch.modelContextManual,
		modelPricingManual: patch.modelPricingManual,
		cacheTtl: patch.cacheTtl,
		spendCapUsd: patch.spendCapUsd,
		spendWarnUsd: patch.spendWarnUsd,
		supportsStreaming: current.supportsStreaming,
		supportsTools: current.supportsTools
	});
}

// Save the Endpoint form. Test connection submits the same form and saves it
// first, so the test runs against what is on screen: a key typed just before
// clicking Test would otherwise race the autosave its blur fires.
async function saveEndpointForm(userId: string, data: FormData) {
	const profile = formText(data, 'toolProfile');
	// An empty box clears the figure (null), rather than being left out, so the
	// writer can remove a cap they set earlier. Anything that is not a
	// non-negative number is refused instead of silently clearing it.
	const usdField = (name: string): number | null | 'invalid' => {
		const raw = formText(data, name).trim();
		if (!raw) return null;
		const value = Number(raw);
		if (!Number.isFinite(value) || value < 0) return 'invalid';
		return value > 0 ? value : null;
	};
	// A whole number from 1 up to the instance maximum. The box is always shown
	// filled in and rides every save of this form, so it is only written when it
	// differs from the value the page loaded with; otherwise an account that
	// never chose a limit would have the default pinned by an unrelated save.
	const limitRaw = formText(data, 'toolCallLimit').trim();
	const toolCallBudget =
		limitRaw && limitRaw !== formText(data, 'toolCallLimitShown').trim()
			? Number(limitRaw)
			: undefined;
	if (
		toolCallBudget !== undefined &&
		(!Number.isInteger(toolCallBudget) || toolCallBudget < 1 || toolCallBudget > MAX_TOOL_BUDGET)
	) {
		return fail(400, {
			scope: 'assistant-endpoint',
			message: `Enter a whole number of lookups from 1 to ${MAX_TOOL_BUDGET}.`
		});
	}
	const spendCapUsd = usdField('spendCapUsd');
	const spendWarnUsd = usdField('spendWarnUsd');
	if (spendCapUsd === 'invalid' || spendWarnUsd === 'invalid') {
		return fail(400, {
			scope: 'assistant-endpoint',
			message: 'Enter an amount in dollars, or leave it blank.'
		});
	}
	// The box is only rendered for an OpenAI-compatible endpoint; a save that
	// did not carry it leaves the stored object alone.
	const extraParams = data.has('extraParams')
		? paramsField(String(data.get('extraParams')))
		: undefined;
	if (extraParams === 'invalid') {
		return fail(400, { scope: 'assistant-endpoint', message: PARAMS_MESSAGE });
	}
	// An unchecked box sends nothing at all, so the hidden marker is what
	// separates "turned off" from "this form never showed the box".
	const webSearch = data.has('webSearchShown') ? data.get('webSearch') === 'on' : undefined;
	// Only on the form for Claude; a save without it keeps what is stored.
	const cacheRaw = formText(data, 'cacheTtl');
	const cacheTtl = (CACHE_TTLS as readonly string[]).includes(cacheRaw)
		? (cacheRaw as CacheTtl)
		: undefined;
	const result = await patchAssistant(userId, {
		provider: normaliseProviderId(data.get('provider')),
		endpoint: formText(data, 'endpoint'),
		apiKey: formText(data, 'apiKey'),
		extraParams,
		webSearch,
		cacheTtl,
		spendCapUsd,
		spendWarnUsd,
		toolCallBudget,
		toolProfile: (TOOL_PROFILES as readonly string[]).includes(profile)
			? (profile as ToolProfile)
			: undefined
	});
	if (!result.ok) return fail(400, { scope: 'assistant-endpoint', message: result.reason });
	// A new host drops the typed prices (see saveAccountLlmConfig), and without
	// them the spend cap cannot be applied, so the reply says which went.
	const cleared = result.clearedPrices ?? [];
	return {
		notice:
			cleared.length > 0
				? `The prices you typed for ${cleared.join(', ')} were cleared because the endpoint changed. Enter them again under Models, or your spend cap cannot be applied.`
				: undefined
	};
}

export const actions: Actions = {
	requestExport: async ({ locals }) => {
		if (!exportLimit(locals.user!.id).allowed) {
			return fail(429, {
				scope: 'export',
				message: 'Too many exports just now. Try again shortly.'
			});
		}
		const result = await requestExport(db, locals.user!.id, { scope: 'account', format: 'zip' });
		if (!result.ok) return fail(400, { scope: 'export', message: result.reason });
		if (!(await queueUserExport(result.id))) {
			await markExportFailed(db, result.id, 'Could not start the export.');
			return fail(503, { scope: 'export', message: 'Could not start the export. Try again.' });
		}
		return { scope: 'export', queued: true };
	},
	updateName: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await saveIdentity(db, locals.user!.id, {
			displayName: formText(data, 'displayName'),
			penName: formText(data, 'penName')
		});
		if (!result.ok) return fail(400, { scope: 'name', message: result.reason });
		return { scope: 'name', saved: true };
	},
	saveProfile: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await saveProfile(db, locals.user!.id, {
			bioMd: formText(data, 'bioMd'),
			profilePublic: data.get('profilePublic') === 'on',
			links: parseLinks(formText(data, 'links')),
			commissionsOpen: data.get('commissionsOpen') === 'on',
			commissionsMd: formText(data, 'commissionsMd')
		});
		if (!result.ok) return fail(400, { scope: 'profile', message: result.reason });
		return { scope: 'profile', saved: true };
	},
	uploadAvatar: async ({ request, locals }) => {
		if (!uploadLimit(locals.user!.id).allowed) {
			return fail(429, {
				scope: 'avatar',
				message: 'Too many uploads just now. Try again shortly.'
			});
		}
		const config = await effectiveAssetConfig(db);
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
		await clearUserAvatar(db, locals.user!.id);
		return { scope: 'avatar', saved: true };
	},
	claimHandle: async ({ request, locals }) => {
		const data = await request.formData();
		// Claiming the handle is the first step into public, so the form may
		// carry the author-name choice; it lands as the pen name unless one is
		// already set.
		const penName = formText(data, 'penName');
		if (penName) await setPenNameIfUnset(db, locals.user!.id, penName);
		const result = await claimHandle(db, locals.user!.id, formText(data, 'handle'));
		if (!result.ok) return fail(400, { scope: 'handle', message: result.reason });
		return { scope: 'handle', saved: true };
	},
	enablePublishing: async ({ locals }) => {
		const result = await enableOwnPublishing(db, {
			id: locals.user!.id,
			role: locals.user!.role
		});
		if (!result.ok) return fail(403, { scope: 'handle', message: result.reason });
		return { scope: 'handle', saved: true };
	},
	savePreferences: async ({ request, locals }) => {
		const data = await request.formData();
		const mode = formText(data, 'entityAutocomplete');
		const marks = formText(data, 'continuousSceneMarks');
		const editing = formText(data, 'editingMode');
		const spell = formText(data, 'spellCheck');
		const language = formText(data, 'writingLanguage');
		const streak = formText(data, 'sessionStreak');
		const nonPrinting = formText(data, 'nonPrintingMarks');
		const command = formText(data, 'commandMarkers');
		// Blank or non-numeric means no goal (0); normalise clamps the rest.
		const dailyWordGoal = Math.trunc(Number(data.get('dailyWordGoal'))) || 0;
		if (mode !== 'popup' && mode !== 'ghost' && mode !== 'off') {
			return fail(400, { scope: 'prefs', message: 'Pick an autocomplete mode.' });
		}
		if (marks !== 'shown' && marks !== 'hidden') {
			return fail(400, { scope: 'prefs', message: 'Pick a scene marks option.' });
		}
		if (nonPrinting !== 'shown' && nonPrinting !== 'hidden') {
			return fail(400, { scope: 'prefs', message: 'Pick a non-printing characters option.' });
		}
		if (command !== 'shown' && command !== 'hidden') {
			return fail(400, { scope: 'prefs', message: 'Pick a command markers option.' });
		}
		if (editing !== 'markdown' && editing !== 'rich') {
			return fail(400, { scope: 'prefs', message: 'Pick an editing mode.' });
		}
		if (spell !== 'on' && spell !== 'off') {
			return fail(400, { scope: 'prefs', message: 'Pick a spell-check option.' });
		}
		if (streak !== 'shown' && streak !== 'hidden') {
			return fail(400, { scope: 'prefs', message: 'Pick a streak option.' });
		}
		await savePreferences(db, locals.user!.id, {
			entityAutocomplete: mode,
			continuousSceneMarks: marks,
			editingMode: editing,
			spellCheck: spell,
			// The select constrains the tags; normalise drops anything else.
			writingLanguage: language,
			sessionStreak: streak,
			nonPrintingMarks: nonPrinting,
			commandMarkers: command,
			dailyWordGoal
		});
		return { scope: 'prefs', saved: true };
	},
	saveEditorAppearance: async ({ request, locals }) => {
		const data = await request.formData();
		const font = formText(data, 'editorFont');
		const lineSpacing = formText(data, 'editorLineSpacing');
		if (!isPageFont(font)) return fail(400, { scope: 'editorappearance', message: 'Pick a font.' });
		if (!isLineSpacing(lineSpacing)) {
			return fail(400, { scope: 'editorappearance', message: 'Pick a line spacing.' });
		}
		await savePreferences(db, locals.user!.id, {
			editorFont: font,
			editorFontCustom: sanitiseFontName(data.get('editorFontCustom')),
			editorLineSpacing: lineSpacing,
			editorLineSpacingCm: clampLineSpacingCm(data.get('editorLineSpacingCm'))
		});
		return { scope: 'editorappearance', saved: true };
	},
	toggleAssistant: async ({ request, locals }) => {
		const data = await request.formData();
		// The kill switch: checked means engaged, which turns the Assistant off.
		const enabled = data.get('killSwitch') !== 'on';
		const result = await patchAssistant(locals.user!.id, { enabled });
		if (!result.ok) return fail(400, { scope: 'assistant-kill', message: result.reason });
		return { scope: 'assistant-kill', saved: true };
	},
	saveAssistantIdentity: async ({ request, locals }) => {
		const data = await request.formData();
		const result = await patchAssistant(locals.user!.id, {
			assistantName: formText(data, 'assistantName'),
			persona: formText(data, 'persona')
		});
		if (!result.ok) return fail(400, { scope: 'assistant-identity', message: result.reason });
		return { scope: 'assistant-identity', saved: true };
	},
	saveAssistantEndpoint: async ({ request, locals }) => {
		const saved = await saveEndpointForm(locals.user!.id, await request.formData());
		if (!('notice' in saved)) return saved;
		return {
			scope: 'assistant-endpoint',
			saved: true,
			...(saved.notice ? { message: `Saved. ${saved.notice}` } : {})
		};
	},
	saveAssistantModels: async ({ request, locals }) => {
		const data = await request.formData();
		const models: ModelMap = {};
		const tuning: TuningMap = {};
		// The form shows the controls the provider can act on: effort for Claude,
		// temperature for an OpenAI-compatible endpoint. A control the form did not
		// show is not part of this save, so its stored value is carried through
		// instead of being wiped (the blank-api-key pattern).
		const storedView = await accountLlmView(db, locals.user!.id);
		const stored = storedView.tuning;
		for (const role of ASSISTANT_ROLES) {
			const value = formText(data, role).trim();
			if (value) models[role] = value;
			const roleTuning: TuningMap[typeof role] = {};

			if (data.has(`${role}-thinking`)) {
				const thinking = String(data.get(`${role}-thinking`));
				if (thinking === 'on') roleTuning.thinking = true;
				else if (thinking === 'off') roleTuning.thinking = false;
			} else if (stored[role]?.thinking !== undefined) {
				roleTuning.thinking = stored[role].thinking;
			}

			if (data.has(`${role}-effort`)) {
				const effort = String(data.get(`${role}-effort`));
				if ((EFFORT_LEVELS as readonly string[]).includes(effort)) {
					roleTuning.effort = effort as EffortLevel;
				}
			} else if (stored[role]?.effort !== undefined) {
				roleTuning.effort = stored[role].effort;
			}

			if (data.has(`${role}-temperature`)) {
				// Blank clears it; the config clamps whatever number lands to 0..2.
				const raw = String(data.get(`${role}-temperature`)).trim();
				const temperature = Number(raw);
				if (raw && Number.isFinite(temperature)) roleTuning.temperature = temperature;
			} else if (stored[role]?.temperature !== undefined) {
				roleTuning.temperature = stored[role].temperature;
			}

			if (data.has(`${role}-maxTokens`)) {
				// Blank clears it, so the role goes back to what the surface asks for.
				const raw = String(data.get(`${role}-maxTokens`)).trim();
				const maxTokens = Number(raw);
				if (raw && Number.isFinite(maxTokens) && maxTokens >= 1) roleTuning.maxTokens = maxTokens;
			} else if (stored[role]?.maxTokens !== undefined) {
				roleTuning.maxTokens = stored[role].maxTokens;
			}

			if (data.has(`${role}-extraParams`)) {
				const extras = paramsField(String(data.get(`${role}-extraParams`)));
				if (extras === 'invalid') {
					return fail(400, { scope: 'assistant-models', message: PARAMS_MESSAGE });
				}
				if (Object.keys(extras).length > 0) roleTuning.extraParams = extras;
			} else if (stored[role]?.extraParams !== undefined) {
				roleTuning.extraParams = stored[role].extraParams;
			}

			if (Object.keys(roleTuning).length > 0) tuning[role] = roleTuning;
		}
		// A context field per model shown on the form (context-<model id>); a blank
		// one drops the writer's entry, so the discovered value applies again. The
		// form only renders the models currently assigned to a role, so the save
		// starts from what is stored and touches only the models it rendered: an
		// entry for a model that was not on the form survives.
		const modelContextManual: ModelContextMap = { ...storedView.modelContextManual };
		for (const [field, value] of data.entries()) {
			if (!field.startsWith('context-')) continue;
			const model = field.slice('context-'.length);
			const tokens = Number(String(value).trim());
			if (Number.isFinite(tokens) && tokens > 0) modelContextManual[model] = Math.floor(tokens);
			else delete modelContextManual[model];
		}
		// A pair of price fields per model shown (price-in-<model id> and
		// price-out-<model id>), in dollars per million tokens. Both blank drops
		// the writer's entry. Half a price, or one that is not an amount, cannot
		// cost a request: that model's stored entry is left as it was, the rest
		// of the form still saves, and the reply says which model to finish.
		// Like the context fields, only the models on the form are touched.
		const modelPricingManual: ModelPricing = { ...storedView.modelPricingManual };
		const unpriced: string[] = [];
		for (const field of data.keys()) {
			if (!field.startsWith('price-in-')) continue;
			const model = field.slice('price-in-'.length);
			const promptRaw = String(data.get(field)).trim();
			const completionRaw = String(data.get(`price-out-${model}`) ?? '').trim();
			if (!promptRaw && !completionRaw) {
				delete modelPricingManual[model];
				continue;
			}
			const prompt = Number(promptRaw);
			const completion = Number(completionRaw);
			if (
				!promptRaw ||
				!completionRaw ||
				!Number.isFinite(prompt) ||
				!Number.isFinite(completion) ||
				prompt < 0 ||
				completion < 0
			) {
				unpriced.push(model);
				continue;
			}
			modelPricingManual[model] = {
				prompt: prompt / TOKENS_PER_MILLION,
				completion: completion / TOKENS_PER_MILLION
			};
		}
		const result = await patchAssistant(locals.user!.id, {
			models,
			tuning,
			modelContextManual,
			modelPricingManual
		});
		if (!result.ok) return fail(400, { scope: 'assistant-models', message: result.reason });
		// A model this save took off its last role has no price boxes after the
		// reload, so its unfinished pair is dropped without a word.
		const shown = new Set([
			...ASSISTANT_ROLES.map((role) =>
				resolveRoleModel(models, role, suggestedModel(storedView.provider, role))
			),
			...(await scopeChosenModels(db, locals.user!.id))
		]);
		const unfinished = unpriced.filter((model) => shown.has(model));
		if (unfinished.length > 0) {
			return {
				scope: 'assistant-models',
				saved: true,
				message: `Saved, except the price for ${unfinished.join(', ')}. Enter both prices as dollar amounts, or leave both empty.`
			};
		}
		return { scope: 'assistant-models', saved: true };
	},
	testAssistant: async ({ request, locals }) => {
		const saved = await saveEndpointForm(locals.user!.id, await request.formData());
		if (!('notice' in saved)) return saved;
		const result = await testAccountConnection(db, locals.user!.id);
		if (!result.ok) {
			return fail(400, {
				scope: 'assistant-test',
				message: saved.notice ? `${result.reason} ${saved.notice}` : result.reason
			});
		}
		return {
			scope: 'assistant-test',
			reply: result.reply,
			...(saved.notice ? { message: saved.notice } : {})
		};
	},
	discoverAssistantModels: async ({ locals }) => {
		const result = await discoverModels(db, locals.user!.id);
		if (!result.ok) return fail(400, { scope: 'assistant-discover', message: result.reason });
		return { scope: 'assistant-discover', models: result.models };
	},
	saveNotifications: async ({ request, locals }) => {
		const data = await request.formData();
		// Only the rows the form showed are written; the admin-only kind keeps
		// its stored value for everyone else.
		const visible = NOTIFICATION_KINDS.filter(
			(kind) => locals.user!.role === 'admin' || !ADMIN_KINDS.includes(kind)
		);
		const matrix: NotificationMatrix = {
			...(await userPreferences(db, locals.user!.id)).notifications
		};
		for (const kind of visible) {
			matrix[kind] = {
				inApp: data.get(`inapp_${kind}`) === 'on',
				email: data.get(`email_${kind}`) === 'on'
			};
		}
		await savePreferences(db, locals.user!.id, { notifications: matrix });
		return { scope: 'notifyprefs', saved: true };
	},
	savePageSetup: async ({ request, locals }) => {
		const data = await request.formData();
		// Selects constrain the values; normalise drops anything else back to
		// the defaults rather than erroring.
		const setup = normalisePageSetup({
			pageSize: formText(data, 'pageSize'),
			margins: formText(data, 'margins'),
			font: formText(data, 'font'),
			fontCustom: formText(data, 'fontCustom'),
			fontSize: Number(data.get('fontSize')),
			paragraphStyle: formText(data, 'paragraphStyle'),
			lineSpacing: formText(data, 'lineSpacing'),
			lineSpacingCm: Number(data.get('lineSpacingCm')),
			textAlign: formText(data, 'textAlign'),
			gutter: formText(data, 'gutter'),
			sceneBreak: formText(data, 'sceneBreak'),
			pageNumbers: data.get('pageNumbers') === 'on',
			runningHeader: data.get('runningHeader') === 'on'
		});
		await saveUserPageSetup(db, locals.user!.id, setup);
		return { scope: 'pagesetup', saved: true };
	},
	saveAppearance: async ({ request, locals }) => {
		const data = await request.formData();
		const theme = formText(data, 'theme');
		const accent = formText(data, 'accent');
		const systemLightTheme = formText(data, 'systemLightTheme');
		const systemDarkTheme = formText(data, 'systemDarkTheme');
		if (!isTheme(theme)) return fail(400, { scope: 'appearance', message: 'Pick a theme.' });
		if (!isAccentColor(accent)) {
			return fail(400, { scope: 'appearance', message: 'Pick a valid accent colour.' });
		}
		await savePreferences(db, locals.user!.id, {
			theme,
			// The mapping fields only show for 'system'; ignore anything invalid so
			// the stored value falls back to the default in the normaliser.
			...(isConcreteTheme(systemLightTheme) ? { systemLightTheme } : {}),
			...(isConcreteTheme(systemDarkTheme) ? { systemDarkTheme } : {}),
			accent: normaliseAccent(accent)
		});
		return { scope: 'appearance', saved: true };
	},
	saveLibraryView: async ({ request, locals }) => {
		const view = (await request.formData()).get('libraryView');
		if (!(await saveLibraryView(db, locals.user!.id, view))) {
			return fail(400, { scope: 'library', message: 'Pick a library view.' });
		}
		return { scope: 'library', saved: true };
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
		// Gated at the step that turns it on: a borrowed session that enrols its
		// own authenticator would lock the owner out, and a password reset does
		// not clear two-factor.
		const limited = reauthGuard(locals.user!.id, 'totp');
		if (limited) return limited;
		const data = await request.formData();
		if (!(await verifyAccountPassword(db, locals.user!.id, formText(data, 'password')))) {
			return fail(400, { scope: 'totp', message: 'That password is not right.' });
		}
		const result = await confirmEnrollment(db, locals.user!.id, formText(data, 'code'));
		if (!result.ok) return fail(400, { scope: 'totp', message: result.reason });
		return { scope: 'totp', recoveryCodes: result.recoveryCodes };
	},
	cancelTotp: async ({ locals }) => {
		// Server-side scoped to an unconfirmed setup: a confirmed enrolment
		// only comes off through the password-gated disable action.
		await cancelPendingEnrollment(db, locals.user!.id);
		return { scope: 'totp', cancelled: true };
	},
	disableTotp: async ({ request, locals }) => {
		const limited = reauthGuard(locals.user!.id, 'totp');
		if (limited) return limited;
		const data = await request.formData();
		if (!(await verifyAccountPassword(db, locals.user!.id, formText(data, 'password')))) {
			return fail(400, { scope: 'totp', message: 'That password is not right.' });
		}
		await disableTotp(db, locals.user!.id);
		return { scope: 'totp', disabled: true };
	},
	regenerateRecovery: async ({ request, locals }) => {
		const limited = reauthGuard(locals.user!.id, 'totp');
		if (limited) return limited;
		const data = await request.formData();
		if (!(await verifyAccountPassword(db, locals.user!.id, formText(data, 'password')))) {
			return fail(400, { scope: 'totp', message: 'That password is not right.' });
		}
		const codes = await regenerateRecoveryCodes(db, locals.user!.id);
		if (!codes) return fail(400, { scope: 'totp', message: 'Two-factor authentication is off.' });
		return { scope: 'totp', recoveryCodes: codes };
	},
	removePasskey: async ({ request, locals }) => {
		const limited = reauthGuard(locals.user!.id, 'passkeys');
		if (limited) return limited;
		const data = await request.formData();
		// Removing a sign-in credential is guarded by the password, the same as
		// turning two-factor off: a borrowed session must not weaken sign-in.
		if (!(await verifyAccountPassword(db, locals.user!.id, formText(data, 'password')))) {
			return fail(400, { scope: 'passkeys', message: 'That password is not right.' });
		}
		const id = formText(data, 'passkeyId');
		if (!isUuid(id) || !(await removePasskey(db, locals.user!.id, id))) {
			return fail(400, { scope: 'passkeys', message: 'That passkey could not be removed.' });
		}
		return { scope: 'passkeys', removed: true };
	},
	changeEmail: async ({ request, locals, url }) => {
		const limited = reauthGuard(locals.user!.id, 'email');
		if (limited) return limited;
		const data = await request.formData();
		const result = await requestEmailChange(
			db,
			locals.user!.id,
			formText(data, 'password'),
			formText(data, 'newEmail')
		);
		if (!result.ok) return fail(400, { scope: 'email', message: result.reason });
		await queueEmail({ tokenId: result.tokenId, to: result.newEmail, origin: publicOrigin(url) });
		return { scope: 'email', sent: true };
	},
	changePassword: async ({ request, locals }) => {
		const limited = reauthGuard(locals.user!.id, 'password');
		if (limited) return limited;
		const data = await request.formData();
		const result = await changePassword(
			db,
			locals.user!.id,
			locals.session!.id,
			formText(data, 'currentPassword'),
			formText(data, 'newPassword')
		);
		if (!result.ok) return fail(400, { scope: 'password', message: result.reason });
		return { scope: 'password', saved: true };
	},
	// Revoking one session stays ungated on purpose, so a lost device can be
	// signed out quickly. Signing out all others is password-gated below.
	revokeSession: async ({ request, locals }) => {
		const data = await request.formData();
		const sessionId = formText(data, 'sessionId');
		if (sessionId === locals.session!.id) {
			return fail(400, { scope: 'sessions', message: 'Use sign out to end your current session.' });
		}
		await revokeOwnSession(db, locals.user!.id, sessionId);
		return { scope: 'sessions', saved: true };
	},
	revokeOthers: async ({ request, locals }) => {
		const limited = reauthGuard(locals.user!.id, 'sessions');
		if (limited) return limited;
		const data = await request.formData();
		if (!(await verifyAccountPassword(db, locals.user!.id, formText(data, 'password')))) {
			return fail(400, { scope: 'sessions', message: 'That password is not right.' });
		}
		await revokeOtherSessions(db, locals.user!.id, locals.session!.id);
		return { scope: 'sessions', saved: true };
	},
	deleteAccount: async ({ request, locals, url, cookies }) => {
		const limited = reauthGuard(locals.user!.id, 'delete');
		if (limited) return limited;
		const data = await request.formData();
		if (!(await verifyAccountPassword(db, locals.user!.id, formText(data, 'password')))) {
			return fail(400, { scope: 'delete', message: 'That password is not right.' });
		}
		const tokenId = await scheduleAccountDeletion(db, locals.user!.id);
		await queueEmail({ tokenId, to: locals.user!.email, origin: publicOrigin(url) });
		// The account is now deactivated; end the current session.
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	},
	// Connected apps: the account's own switch for outside apps, and
	// disconnecting one. Turning the switch off disconnects them all.
	setExternalAccess: async ({ request, locals }) => {
		if (!(await mcpInstanceEnabled(db))) error(404, 'Not found');
		const data = await request.formData();
		const enabled = formText(data, 'enabled') === 'on';
		const userId = locals.user!.id;
		// Turning it off asks for nothing. Turning it on is what lets an app
		// in, so a signed-in browser alone is not enough.
		if (enabled && !(await mcpAccountEnabled(db, userId))) {
			const refused = await confirmIdentity(userId, data, 'access');
			if (refused) return refused;
		}
		await setMcpAccountEnabled(db, userId, enabled);
		return { scope: 'apps', saved: true };
	},
	revokeApp: async ({ request, locals }) => {
		const grantId = formText(await request.formData(), 'grantId');
		if (!isUuid(grantId) || !(await revokeGrant(db, locals.user!.id, grantId))) {
			return fail(400, { scope: 'apps', message: 'That app is not connected any more.' });
		}
		return { scope: 'apps', saved: true };
	},
	// A personal access token, for a program of the writer's own. It acts as
	// the writer does through an app, so making one re-checks the password,
	// and the second factor when the account has one. The token is in this
	// one response and nowhere after it.
	createToken: async ({ request, locals }) => {
		if (!(await mcpInstanceEnabled(db))) error(404, 'Not found');
		const userId = locals.user!.id;
		const data = await request.formData();
		const refused = await confirmIdentity(userId, data, 'tokens');
		if (refused) return refused;
		const created = await createPersonalToken(db, {
			userId,
			name: formText(data, 'name'),
			permissions: data.getAll('permission').map(String),
			expiresInDays: Number(formText(data, 'expiresInDays'))
		});
		if (!created.ok) return fail(400, { scope: 'tokens', message: created.reason });
		return { scope: 'tokens', token: created.token, tokenId: created.id };
	},
	revokePersonalToken: async ({ request, locals }) => {
		const grantId = formText(await request.formData(), 'grantId');
		if (!isUuid(grantId) || !(await revokeGrant(db, locals.user!.id, grantId))) {
			return fail(400, { scope: 'tokens', message: 'That token is already revoked.' });
		}
		return { scope: 'tokens', saved: true };
	},
	// The Invites section: generate a single-use code against the admin-set
	// allowance, or revoke one that has not been used.
	createInvite: async ({ locals }) => {
		const code = await createUserInvite(db, locals.user!.id);
		if (!code) {
			return fail(400, { scope: 'invites', message: 'You have no invites left.' });
		}
		return { scope: 'invites', saved: true };
	},
	deleteInvite: async ({ request, locals }) => {
		const inviteId = formText(await request.formData(), 'inviteId');
		if (!isUuid(inviteId) || !(await deleteUserInviteCode(db, locals.user!.id, inviteId))) {
			return fail(400, {
				scope: 'invites',
				message: 'Only your own unused invites can be revoked.'
			});
		}
		return { scope: 'invites', saved: true };
	}
};
