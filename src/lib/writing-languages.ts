// The writing-language choices offered in the preference selects, each a
// BCP 47 tag the browser's spell-checker understands. The preference also
// accepts any valid tag, so a missing language is one normalise away from
// being supported; this list is just the friendly menu.
export const WRITING_LANGUAGES = [
	{ tag: 'da', label: 'Dansk' },
	{ tag: 'de', label: 'Deutsch' },
	{ tag: 'en-GB', label: 'English (UK)' },
	{ tag: 'en-US', label: 'English (US)' },
	{ tag: 'es', label: 'Espanol' },
	{ tag: 'fr', label: 'Francais' },
	{ tag: 'it', label: 'Italiano' },
	{ tag: 'nl', label: 'Nederlands' },
	{ tag: 'nb', label: 'Norsk' },
	{ tag: 'pl', label: 'Polski' },
	{ tag: 'pt', label: 'Portugues' },
	{ tag: 'fi', label: 'Suomi' },
	{ tag: 'sv', label: 'Svenska' }
] as const;

export function writingLanguageLabel(tag: string): string {
	return WRITING_LANGUAGES.find((language) => language.tag === tag)?.label ?? tag;
}
