// The Assistant's name and tone - a little personality, set per account. This
// is deliberately not a free-form system prompt: a fixed set of tone presets
// keeps the Assistant a writing aid and does not hand back the role-play
// escape hatch the design closes (see assistant.md "Open questions"). The name
// is cosmetic; the persona only nudges tone, never the task.

export const PERSONAS = [
	{
		id: 'balanced',
		label: 'Balanced',
		description: 'Helpful and clear, neither terse nor chatty.',
		prompt: 'Keep a balanced, helpful tone: clear and warm, without being wordy.'
	},
	{
		id: 'concise',
		label: 'Concise',
		description: 'Short, direct answers with no preamble.',
		prompt: 'Be concise and direct. Prefer short answers and skip preamble and filler.'
	},
	{
		id: 'professional',
		label: 'Professional',
		description: 'Formal and precise.',
		prompt: 'Keep a professional, precise tone. Use full sentences and avoid slang.'
	},
	{
		id: 'casual',
		label: 'Casual',
		description: 'Relaxed and conversational.',
		prompt: 'Keep a casual, conversational tone, like a friendly writing partner.'
	},
	{
		id: 'encouraging',
		label: 'Encouraging',
		description: 'Warm and motivating, while staying honest.',
		prompt:
			'Keep an encouraging, supportive tone that motivates the writer, while staying honest about problems.'
	}
] as const;

export type Persona = (typeof PERSONAS)[number]['id'];

export const DEFAULT_PERSONA: Persona = 'balanced';

// The longest an assistant name may be; cosmetic, so a generous single line.
export const MAX_ASSISTANT_NAME = 60;

const PERSONA_IDS = PERSONAS.map((p) => p.id) as readonly string[];

export function isPersona(value: unknown): value is Persona {
	return typeof value === 'string' && PERSONA_IDS.includes(value);
}

export function normalisePersona(value: unknown): Persona {
	return isPersona(value) ? value : DEFAULT_PERSONA;
}

// Trim, fold any newlines to spaces, and cap the length, so a stored name is
// always a clean single line.
export function normaliseAssistantName(value: unknown): string {
	if (typeof value !== 'string') return '';
	return value.replace(/\s+/g, ' ').trim().slice(0, MAX_ASSISTANT_NAME);
}

function personaPrompt(persona: Persona): string {
	return (PERSONAS.find((p) => p.id === persona) ?? PERSONAS[0]).prompt;
}

// The system message that gives the Assistant its name and tone. The gateway
// prepends this to every turn so the personality is consistent across surfaces.
export function buildPersonaPrompt(name: string, persona: Persona): string {
	const who = name.trim() || 'the Assistant';
	return (
		`You are ${who}, a writing assistant inside the author's writing workspace. ` +
		'You help the author with their own long-form fiction and worldbuilding. ' +
		`${personaPrompt(persona)} ` +
		'Stay in this helper role; do not play characters from the story.'
	);
}
