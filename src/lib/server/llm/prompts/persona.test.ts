import { describe, it, expect } from 'vitest';
import {
	buildPersonaPrompt,
	DEFAULT_PERSONA,
	isPersona,
	MAX_ASSISTANT_NAME,
	normaliseAssistantName,
	normalisePersona,
	PERSONAS
} from './persona';

describe('persona presets', () => {
	it('has a stable, non-empty set with unique ids and prompts', () => {
		expect(PERSONAS.length).toBeGreaterThan(0);
		const ids = PERSONAS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const persona of PERSONAS) {
			expect(persona.label.length).toBeGreaterThan(0);
			expect(persona.prompt.length).toBeGreaterThan(0);
		}
	});

	it('includes the default and the tones the writer asked for', () => {
		const ids = PERSONAS.map((p) => p.id);
		expect(ids).toContain(DEFAULT_PERSONA);
		expect(ids).toEqual(expect.arrayContaining(['concise', 'professional', 'casual']));
	});
});

describe('isPersona / normalisePersona', () => {
	it('recognises a real preset id', () => {
		expect(isPersona('concise')).toBe(true);
		expect(isPersona('nonsense')).toBe(false);
		expect(isPersona(7)).toBe(false);
	});

	it('falls back to the default for anything unknown', () => {
		expect(normalisePersona('concise')).toBe('concise');
		expect(normalisePersona('nope')).toBe(DEFAULT_PERSONA);
		expect(normalisePersona(undefined)).toBe(DEFAULT_PERSONA);
	});
});

describe('normaliseAssistantName', () => {
	it('trims, folds whitespace, and caps the length', () => {
		expect(normaliseAssistantName('  Muse  ')).toBe('Muse');
		expect(normaliseAssistantName('line\nbreak')).toBe('line break');
		expect(normaliseAssistantName('x'.repeat(200))).toHaveLength(MAX_ASSISTANT_NAME);
	});

	it('returns an empty string for non-strings', () => {
		expect(normaliseAssistantName(undefined)).toBe('');
		expect(normaliseAssistantName(42)).toBe('');
	});
});

describe('buildPersonaPrompt', () => {
	it('uses the given name and the persona tone', () => {
		const prompt = buildPersonaPrompt('Muse', 'concise');
		expect(prompt).toContain('You are Muse,');
		expect(prompt).toContain('concise');
	});

	it('falls back to a generic name when none is set', () => {
		expect(buildPersonaPrompt('', 'balanced')).toContain('You are the Assistant,');
	});

	it('keeps the Assistant in its helper role (no role-play)', () => {
		expect(buildPersonaPrompt('Muse', 'casual').toLowerCase()).toContain('do not play characters');
	});
});
