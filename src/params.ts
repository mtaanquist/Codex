import { defineParams } from '@sveltejs/kit/params';

// Restricts a route param to a UUID, so a malformed id (e.g. /@handle/foo)
// gets a clean 404 from the router instead of reaching a uuid-typed query
// and surfacing a Postgres cast error as a 500.
const matchUuid = (param: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);

export const params = defineParams({
	uuid: (param) => (matchUuid(param) ? param : undefined)
});
