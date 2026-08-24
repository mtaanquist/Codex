// The request fields an adapter owns, and which a writer's stored extra
// parameters may never rewrite: they carry the model, the conversation, the
// tool definitions, and the streaming contract the response parser depends on.
//
// This lives beside the adapters rather than in the config, because it is
// knowledge about the wire format. The config layer refuses these on save and
// strips them on read (see ../config), and the OpenAI-compatible adapter strips
// them again as it builds the body, so neither layer alone is load-bearing.

export const RESERVED_PARAM_KEYS = [
	'model',
	'messages',
	'max_tokens',
	'tools',
	'tool_choice',
	'stream',
	'stream_options'
] as const;

// Which of a writer's parameters name a reserved field, so a save can say so
// rather than dropping them silently.
export function reservedParamKeys(params: Record<string, unknown>): string[] {
	return Object.keys(params).filter((key) =>
		(RESERVED_PARAM_KEYS as readonly string[]).includes(key)
	);
}

// The same object with any reserved field removed. Returns undefined when
// nothing is left, so a caller can omit the spread entirely.
export function withoutReservedParams(
	params: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
	if (!params) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if ((RESERVED_PARAM_KEYS as readonly string[]).includes(key)) continue;
		out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
