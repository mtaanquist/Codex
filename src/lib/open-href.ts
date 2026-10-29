import { goto } from '$app/navigation';

// Opens an app address that came from data, such as a notification or an
// activity row. goto refuses an address that is not a page (an export
// download is an endpoint), so those get a full load, as a plain link would.
export async function openHref(href: string): Promise<void> {
	try {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- app path built server-side
		await goto(href);
	} catch {
		location.assign(href);
	}
}
