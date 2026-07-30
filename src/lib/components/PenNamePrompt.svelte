<script lang="ts">
	// Asked once, at the first step into public: claiming a handle or
	// publishing an edition with no pen name set. The public pages name the
	// author by pen name and fall back to the display name, so this makes
	// that fallback a choice. Confirming hands back a name (the typed one,
	// or the display name it was seeded with); the caller submits it with
	// its own form and the server records it as the pen name.

	let {
		open,
		displayName,
		onConfirm,
		onCancel
	}: {
		open: boolean;
		displayName: string;
		onConfirm: (penName: string) => void;
		onCancel: () => void;
	} = $props();

	let penName = $state('');
	let lastOpen = false;
	$effect(() => {
		if (open && !lastOpen) penName = displayName;
		lastOpen = open;
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onCancel();
		}
	}
</script>

{#if open}
	<div
		class="modal-backdrop"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) onCancel();
		}}
		onkeydown={onKeydown}
	>
		<div class="modal-panel" role="dialog" aria-modal="true" aria-label="Choose your author name">
			<div class="modal-head">
				<div class="modal-head-main">
					<h2 class="modal-title">What name goes on the page?</h2>
					<p class="modal-sub">
						Your public page and published stories name their author. Keep your display name, or set
						a pen name to publish under instead.
					</p>
				</div>
			</div>
			<div class="modal-body">
				<div class="field" style="margin-bottom:0;">
					<label for="pen-name-prompt">Author name</label>
					<input
						id="pen-name-prompt"
						class="input"
						type="text"
						maxlength="120"
						bind:value={penName}
					/>
					<p class="field-hint">You can change the pen name on your account page at any time.</p>
				</div>
			</div>
			<div class="modal-foot">
				<div class="modal-foot-note"></div>
				<button class="btn btn-sm btn-secondary" type="button" onclick={onCancel}>Cancel</button>
				<button
					class="btn btn-sm btn-primary"
					type="button"
					onclick={() => onConfirm(penName.trim() || displayName)}
				>
					Continue
				</button>
			</div>
		</div>
	</div>
{/if}
