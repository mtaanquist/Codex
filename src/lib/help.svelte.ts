// Shared state for the in-app help modal: which topic is open, if any. A
// HelpLink sets it; the single HelpModal mounted in the root layout reads it.

export const help = $state<{ topic: string | null }>({ topic: null });

export function openHelp(topic: string): void {
	help.topic = topic;
}

export function closeHelp(): void {
	help.topic = null;
}
