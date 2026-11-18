<script lang="ts">
	import {
		clampPaneWidth,
		PANE_BOUNDS,
		PANE_STEP,
		paneMax,
		resetPaneWidth,
		setPaneWidth,
		type PaneSide
	} from '#lib/pane-widths';

	// A drag handle on the inner edge of one side column of a workspace .body.
	// Place it as the first child of the column's aside.pane, so it sits inside
	// that landmark. It is positioned against the .body, not the aside, so it
	// neither scrolls nor clips with the column. Arrow keys resize, double-click
	// (or Enter) resets.
	let { side }: { side: PaneSide } = $props();

	let handle: HTMLDivElement | undefined = $state();
	let width = $state(0);
	let viewport = $state(0);
	let drag: { startX: number; startW: number } | null = $state(null);

	function pane(): HTMLElement | null {
		return handle?.closest<HTMLElement>('.pane') ?? null;
	}

	function measure() {
		viewport = window.innerWidth;
		width = Math.round(pane()?.getBoundingClientRect().width ?? 0);
	}

	function apply(px: number) {
		const next = clampPaneWidth(side, px, window.innerWidth);
		setPaneWidth(side, next);
		width = next;
		viewport = window.innerWidth;
	}

	function onPointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		event.preventDefault();
		measure();
		drag = { startX: event.clientX, startW: width };
		handle?.setPointerCapture(event.pointerId);
		document.documentElement.classList.add('pane-resizing');
	}

	function onPointerMove(event: PointerEvent) {
		if (!drag) return;
		const dx = event.clientX - drag.startX;
		apply(side === 'left' ? drag.startW + dx : drag.startW - dx);
	}

	function endDrag(event: PointerEvent) {
		if (!drag) return;
		drag = null;
		if (handle?.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
		document.documentElement.classList.remove('pane-resizing');
	}

	function reset() {
		resetPaneWidth(side);
		measure();
	}

	function onKeydown(event: KeyboardEvent) {
		// Left and right move the edge itself, whichever column it belongs to.
		const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
		const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
		measure();
		if (event.key === grow) apply(width + PANE_STEP);
		else if (event.key === shrink) apply(width - PANE_STEP);
		else if (event.key === 'Home') apply(PANE_BOUNDS[side].min);
		else if (event.key === 'End') apply(paneMax(side, window.innerWidth));
		else if (event.key === 'Enter') reset();
		else return;
		event.preventDefault();
	}
</script>

<svelte:window onresize={measure} />

<!-- A focusable separator with a value is an interactive widget in ARIA (a
     window splitter); Svelte's check counts every separator as static. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	bind:this={handle}
	class="pane-resizer {side}"
	class:dragging={drag !== null}
	role="separator"
	aria-orientation="vertical"
	aria-label={side === 'left' ? 'Resize the left sidebar' : 'Resize the right sidebar'}
	aria-valuenow={width || undefined}
	aria-valuemin={PANE_BOUNDS[side].min}
	aria-valuemax={viewport ? paneMax(side, viewport) : undefined}
	title="Drag to resize. Double-click to reset."
	tabindex="0"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={endDrag}
	onpointercancel={endDrag}
	ondblclick={reset}
	onkeydown={onKeydown}
	onfocus={measure}
></div>
