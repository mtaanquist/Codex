// Lifetimes and limits for external access, in one place so they are easy to
// change together.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The path of the MCP endpoint; with the site origin in front it is also the
// resource the tokens are issued for.
export const MCP_PATH = '/api/mcp';

export const CODE_TTL_MS = MINUTE;
export const ACCESS_TOKEN_TTL_MS = HOUR;
// Sliding: each refresh issues a new refresh token with a fresh lifetime.
export const REFRESH_TOKEN_TTL_MS = 30 * DAY;

// The grant's last-used stamp is refreshed at most this often.
export const LAST_USED_REFRESH_MS = 5 * MINUTE;

// A cached client metadata document is fetched again after this long.
export const CLIENT_DOCUMENT_TTL_MS = DAY;
export const CLIENT_DOCUMENT_MAX_BYTES = 64 * 1024;
export const CLIENT_DOCUMENT_TIMEOUT_MS = 5000;

// Clean-up windows (see purgeExternalAccess).
export const UNUSED_CLIENT_RETENTION = '24 hours';
export const REVOKED_CLIENT_RETENTION = '30 days';
export const SPENT_CODE_RETENTION = '1 day';

export const MAX_REDIRECT_URIS = 10;
export const MAX_CLIENT_NAME = 120;
export const MAX_URI_LENGTH = 2000;

// Registrations one address may make per hour.
export const REGISTER_PER_HOUR = 30;
// Token and revoke requests one address may make per minute.
export const TOKEN_PER_MINUTE = 120;

// Tool calls one connected app may make per minute, and one writer across all
// their apps, so connecting several does not multiply the first number.
export const READ_CALLS_PER_MINUTE = 120;
export const READ_CALLS_PER_MINUTE_PER_USER = 240;
// Every request to the endpoint, of any kind, per writer per minute.
export const REQUESTS_PER_MINUTE = 600;

// Clients cut a tool result off at about 150,000 characters, so results stay
// under that with room for the JSON around a scene's text.
export const TOOL_RESULT_MAX_CHARS = 140_000;
export const SCENE_BODY_MAX_CHARS = 120_000;
