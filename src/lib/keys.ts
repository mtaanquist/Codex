import { browser } from '$app/environment';

// Whether a platform string names an Apple device, where the command
// modifier is Cmd rather than Ctrl.
export function isApplePlatform(platform: string): boolean {
	return /mac|iphone|ipad|ipod/i.test(platform);
}

// The label for the platform's command modifier. The server cannot know the
// platform, so SSR says Ctrl; callers re-read this after mount to correct it.
export function modLabel(): 'Cmd' | 'Ctrl' {
	if (!browser) return 'Ctrl';
	const platform =
		(navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
		navigator.platform ??
		'';
	return isApplePlatform(platform) ? 'Cmd' : 'Ctrl';
}
