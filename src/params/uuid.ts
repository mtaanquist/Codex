import type { ParamMatcher } from '@sveltejs/kit';

// Restricts a route param to a UUID, so a malformed id (e.g. /@handle/foo)
// gets a clean 404 from the router instead of reaching a uuid-typed query
// and surfacing a Postgres cast error as a 500.
export const match: ParamMatcher = (param) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);
