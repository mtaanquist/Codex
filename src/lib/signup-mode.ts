// Who can create an account on this Codex. 'approval' matches the behaviour
// from before the setting existed, so a Codex that has never saved one keeps
// working the same way.
//
// The list lives here rather than in $lib/server/settings.ts because the
// landing page and the sign-in page render from the mode, and neither may pull
// a server module into the browser. The setting itself is still read and
// written server-side.
export const SIGNUP_MODES = ['none', 'invite', 'approval', 'open'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

// Whether a visitor with no invite code can get themselves an account. In
// 'invite' mode the sign-up page still works from an invite link, but a
// codeless visitor cannot succeed, so nothing offers them the page.
export function signupOffered(mode: SignupMode): boolean {
	return mode === 'open' || mode === 'approval';
}
