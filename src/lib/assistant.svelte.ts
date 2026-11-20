// Cross-component intents for the Assistant: a menu or the command palette
// asks for something, the story page switches the right pane to the Assistant
// tab, and the panel consumes the intent when it mounts or sees the change.
// Lives here, like focus-mode.svelte.ts, so surfaces outside the page tree
// (the command palette) can raise intents too.

export type AssistantIntent =
	// Put a reference to scene text into the composer; the writer adds their
	// question and sends.
	| { kind: 'reference'; sceneId: string; text: string }
	// Put a starter prompt into the composer for the writer to edit and send.
	| { kind: 'prefill'; text: string }
	// Open the scene draft form for the open scene (or its draft, when it has
	// one).
	| { kind: 'draft' }
	// Open the chapter draft form for a chapter (or its drafts, while they
	// are being written).
	| { kind: 'draft-chapter'; chapterId: string }
	// Run the recap ("catch me up").
	| { kind: 'catchup' }
	// Just open the tab and focus the composer.
	| { kind: 'focus' };

export const assistantIntent = $state<{ pending: AssistantIntent | null }>({ pending: null });
