import { browser } from '$app/environment';

// Whether a platform string names an Apple device, where the command
// modifier is Cmd rather than Ctrl.
export function isApplePlatform(platform: string): boolean {
	return /mac|iphone|ipad|ipod/i.test(platform);
}

function currentPlatform(): string {
	return (
		(navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
		navigator.platform ??
		''
	);
}

// The label for the platform's command modifier. The server cannot know the
// platform, so SSR says Ctrl; callers re-read this after mount to correct it.
export function modLabel(): 'Cmd' | 'Ctrl' {
	if (!browser) return 'Ctrl';
	return isApplePlatform(currentPlatform()) ? 'Cmd' : 'Ctrl';
}

// The label for the platform's alternate modifier, which Apple keyboards call
// Option. Same SSR caveat as modLabel.
export function altLabel(): 'Option' | 'Alt' {
	if (!browser) return 'Alt';
	return isApplePlatform(currentPlatform()) ? 'Option' : 'Alt';
}

// Rewrites shortcut combos in help text for Apple keyboards: Ctrl+ becomes
// Cmd+ and Alt+ becomes Option+. Only the combo forms are touched, so prose
// that merely names the keys stays as written.
export function appleShortcutLabels(text: string): string {
	return text.replace(/\bCtrl\+/g, 'Cmd+').replace(/\bAlt\+/g, 'Option+');
}
