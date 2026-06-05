<script lang="ts">
	import type { EditorView } from '@codemirror/view';
	import Icon from './Icon.svelte';
	import {
		setHeading,
		toggleBold,
		toggleBulletList,
		toggleItalic,
		toggleQuote
	} from '$lib/editor-format';

	// The formatting bar above a prose editor: headings, bold, italic,
	// quote, list. Buttons act on the editor and hand focus straight back.
	let { view, modeLabel }: { view: () => EditorView | undefined; modeLabel?: string } = $props();

	function run(command: (view: EditorView) => boolean) {
		const editor = view();
		if (!editor) return;
		command(editor);
		editor.focus();
	}
</script>

<div class="md-toolbar">
	<button
		class="md-tool"
		type="button"
		title="Heading 1"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(setHeading(1))}
	>
		<span class="md-tool-label">H1</span>
	</button>
	<button
		class="md-tool"
		type="button"
		title="Heading 2"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(setHeading(2))}
	>
		<span class="md-tool-label">H2</span>
	</button>
	<button
		class="md-tool"
		type="button"
		title="Heading 3"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(setHeading(3))}
	>
		<span class="md-tool-label">H3</span>
	</button>
	<span class="md-sep"></span>
	<button
		class="md-tool"
		type="button"
		title="Bold (Ctrl+B)"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(toggleBold)}
	>
		<Icon name="bold" size={16} />
	</button>
	<button
		class="md-tool"
		type="button"
		title="Italic (Ctrl+I)"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(toggleItalic)}
	>
		<Icon name="italic" size={16} />
	</button>
	<span class="md-sep"></span>
	<button
		class="md-tool"
		type="button"
		title="Quote"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(toggleQuote)}
	>
		<Icon name="quote" size={16} />
	</button>
	<button
		class="md-tool"
		type="button"
		title="Bullet list"
		onmousedown={(event) => event.preventDefault()}
		onclick={() => run(toggleBulletList)}
	>
		<Icon name="list" size={16} />
	</button>
	{#if modeLabel}
		<span class="md-hint">{modeLabel}</span>
	{/if}
</div>
