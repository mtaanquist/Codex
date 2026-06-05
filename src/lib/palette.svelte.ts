// Shared state for the command palette: open or not. Topbar buttons and
// the global Ctrl+K handler set it; the single CommandPalette mounted in
// the root layout reads it.

export const palette = $state<{ open: boolean }>({ open: false });

export function openPalette(): void {
	palette.open = true;
}

export function closePalette(): void {
	palette.open = false;
}
