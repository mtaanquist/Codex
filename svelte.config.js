import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		// Scripts only from this origin, plus the inline ones SvelteKit (and the
		// theme script in app.html) mark with a nonce. Styles are left open:
		// Svelte transitions insert inline style elements.
		csp: {
			mode: 'auto',
			directives: {
				'script-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'frame-ancestors': ['none'],
				'frame-src': ['none'],
				'form-action': ['self']
			}
		}
	}
};

export default config;
