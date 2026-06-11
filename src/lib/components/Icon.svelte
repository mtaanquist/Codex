<script lang="ts" module>
	// Stroke icon set ported from the prototype's icons.jsx.
	const PATHS = {
		feather: ['M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z', 'M16 8 2 22', 'M17.5 15H9'],
		chevron: ['M9 6l6 6-6 6'],
		// Marks a link that leaves the current view.
		'arrow-out': ['M7 17 17 7', 'M8 7h9v9'],
		plus: ['M12 5v14', 'M5 12h14'],
		bell: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.7 21a2 2 0 0 1-3.4 0'],
		expand: [
			'M8 3H5a2 2 0 0 0-2 2v3',
			'M21 8V5a2 2 0 0 0-2-2h-3',
			'M16 21h3a2 2 0 0 0 2-2v-3',
			'M3 16v3a2 2 0 0 0 2 2h3'
		],
		send: ['M22 2 11 13', 'M22 2 15 22l-4-9-9-4 20-7z'],
		universe: [
			'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
			'M2 12h20',
			'M12 2c3 3 4.5 6.5 4.5 10S15 19 12 22c-3-3-4.5-6.5-4.5-10S9 5 12 2z'
		],
		book: [
			'M4 19.5A2.5 2.5 0 0 1 6.5 17H20',
			'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'
		],
		chapter: ['M4 6h16', 'M4 12h16', 'M4 18h10'],
		print: [
			'M6 9V2h12v7',
			'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2',
			'M6 14h12v8H6z'
		],
		// Two overlapping sheets: duplicate.
		copy: [
			'M9 9h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z',
			'M5 15H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1'
		],
		'align-left': ['M4 6h16', 'M4 10h10', 'M4 14h16', 'M4 18h10'],
		'align-center': ['M4 6h16', 'M7 10h10', 'M4 14h16', 'M7 18h10'],
		'align-right': ['M4 6h16', 'M10 10h10', 'M4 14h16', 'M10 18h10'],
		'align-justify': ['M4 6h16', 'M4 10h16', 'M4 14h16', 'M4 18h16'],
		// A page break: text above and below a dashed cut line.
		split: [
			'M4 5h16',
			'M4 9h10',
			'M4 12h2',
			'M9 12h2',
			'M14 12h2',
			'M19 12h1',
			'M4 15h16',
			'M4 19h10'
		],
		scene: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
		user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
		pin: [
			'M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z',
			'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'
		],
		sparkles: [
			'M12 3l1.9 4.8L18.7 9 14 11l-2 5-2-5L5.3 9l4.8-1.2z',
			'M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z'
		],
		sun: [
			'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
			'M12 1v3',
			'M12 20v3',
			'M4.2 4.2l2.1 2.1',
			'M17.7 17.7l2.1 2.1',
			'M1 12h3',
			'M20 12h3',
			'M4.2 19.8l2.1-2.1',
			'M17.7 6.3l2.1-2.1'
		],
		moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
		search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
		link: [
			'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5',
			'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5'
		],
		note: ['M11 4H4v16h16v-7', 'M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z'],
		dot: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
		compress: [
			'M9 9H4',
			'M9 9V4',
			'M15 9h5',
			'M15 9V4',
			'M9 15H4',
			'M9 15v5',
			'M15 15h5',
			'M15 15v5'
		],
		bold: ['M7 5h6.5a3.5 3.5 0 0 1 0 7H7z', 'M7 12h7.5a3.5 3.5 0 0 1 0 7H7z'],
		italic: ['M19 4h-7', 'M12 20H5', 'M15 4 9 20'],
		quote: ['M6 17h3l2-3.5V7H5v6.5h2.5z', 'M15 17h3l2-3.5V7h-6v6.5h2.5z'],
		list: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
		gear: [
			'M12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z',
			'M12 2.5v2.4 M12 19.1v2.4 M4.2 4.2l1.7 1.7 M18.1 18.1l1.7 1.7 M2.5 12h2.4 M19.1 12h2.4 M4.2 19.8l1.7-1.7 M18.1 5.9l1.7-1.7'
		],
		clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
		pencil: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
		trash: [
			'M3 6h18',
			'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
			'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
			'M10 11v6',
			'M14 11v6'
		],
		restore: ['M3 8a9 9 0 1 1-2 5.7', 'M3 4v4h4'],
		tag: [
			'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-6.2-6.2a2 2 0 0 1 0-2.8L11.6 4.4a2 2 0 0 1 1.4-.6H19a2 2 0 0 1 2 2v6a2 2 0 0 1-.4 1.4z',
			'M16 8h.01'
		],
		// Pilcrow: the show-formatting-marks toggle.
		pilcrow: ['M13 4v16', 'M17 4v16', 'M19 4H9.5a4.5 4.5 0 0 0 0 9H13'],
		// Eye: the show/hide command-markers toggle.
		eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
		// Increase / decrease paragraph indent.
		'indent-increase': ['M3 8l4 4-4 4', 'M21 12H11', 'M21 6H11', 'M21 18H11'],
		'indent-decrease': ['M7 8l-4 4 4 4', 'M21 12H11', 'M21 6H11', 'M21 18H11'],
		// Overflow ("more") menu: three dots.
		more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
		// Review: a speech bubble for comments, and the same with a plus.
		comment: [
			'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z'
		],
		'comment-plus': [
			'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z',
			'M12 8v5',
			'M9.5 10.5h5'
		],
		// A pencil over a line: suggest an edit.
		suggest: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', 'M14 6l3 3'],
		check: ['M20 6 9 17l-5-5'],
		'check-circle': ['M22 11.1V12a10 10 0 1 1-5.9-9.1', 'M22 4 12 14.1l-3-3'],
		close: ['M18 6 6 18', 'M6 6l12 12'],
		// Admin shield and sign-out, for the avatar menu.
		shield: ['M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5z'],
		logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
		reply: ['M9 17l-5-5 5-5', 'M4 12h11a5 5 0 0 1 5 5v2']
	} as const;

	export type IconName = keyof typeof PATHS;
</script>

<script lang="ts">
	let {
		name,
		size = 16,
		fill = false
	}: { name: IconName; size?: number; fill?: boolean } = $props();
</script>

<svg
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill={fill ? 'currentColor' : 'none'}
	stroke={fill ? 'none' : 'currentColor'}
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
>
	{#each PATHS[name] as d (d)}
		<path {d} />
	{/each}
</svg>
