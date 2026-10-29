import { enhance as kitEnhance, type SubmitFunction } from '$app/forms';

// SvelteKit's enhance, but a result stays on the page that submitted it, as it
// did before kit 3. Kit 3 navigates to where the action lands when that URL
// differs from the current one, query included, and a `?/action` drops the
// page's own query (?scene=, ?entity=), so every action on such a page would
// reload it without its selection. Redirects are still followed. Pass
// `navigate: true` to update() to opt back in.
export function enhance<
	Success extends Record<string, unknown> | undefined,
	Failure extends Record<string, unknown> | undefined
>(form: HTMLFormElement, submit?: SubmitFunction<Success, Failure>) {
	return kitEnhance<Success, Failure>(form, async (input) => {
		const callback = await submit?.(input);
		return async (opts) => {
			const update: typeof opts.update = (options) => opts.update({ navigate: false, ...options });
			if (callback) await callback({ ...opts, update });
			else await update();
		};
	});
}
