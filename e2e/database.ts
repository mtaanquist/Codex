// The end-to-end suite gets its own database, the way the integration tests get
// codex_test. It used to share the development database, but the specs create a
// universe and story per run and never remove them, so that database grew
// without bound. Past a few hundred the dashboard was slow enough that
// assertions started missing their timeout, and since the failures landed on
// story creation and scene switching rather than on the feature under test, the
// failing spec looked arbitrary from one run to the next. CI never saw it,
// starting empty every time.
//
// A separate database also keeps a suite run from writing all over the
// universes and stories being used for development.
export const E2E_DATABASE_URL =
	process.env.E2E_DATABASE_URL ?? 'postgres://codex:codex@localhost:5432/codex_e2e';
