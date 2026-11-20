import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import { loadConfig } from '@sveltejs/load-config';

const svelteConfig = (await loadConfig('./', { traverse: false }))?.config;

// Display formatting goes through #lib/format so the locale stays fixed.
const fixedLocale = [
	{
		selector: 'CallExpression[callee.property.name=/^toLocale(String|DateString|TimeString)$/]',
		message: 'Use a #lib/format helper so the display locale stays fixed.'
	},
	{
		selector:
			":matches(NewExpression, CallExpression)[callee.object.name='Intl'][callee.property.name=/^(DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|PluralRules)$/]",
		message: 'Use a #lib/format helper so the display locale stays fixed.'
	}
];

// Stored timestamps come from the database clock (see src/lib/server/db-clock.ts).
const appClockStamp =
	'Stamp stored times with the database clock: sql`now()`, or dbNow() from #lib/server/db-clock.';
const oneClock = [
	{
		selector: "CallExpression[callee.property.name='$onUpdate'] NewExpression[callee.name='Date']",
		message: appClockStamp
	},
	{
		selector:
			"CallExpression[callee.property.name=/^(set|values)$/] > :matches(ObjectExpression, ArrayExpression) NewExpression[callee.name='Date'][arguments.length=0]",
		message: appClockStamp
	},
	{
		selector:
			"Property[key.name='set'] > ObjectExpression NewExpression[callee.name='Date'][arguments.length=0]",
		message: appClockStamp
	},
	{
		selector:
			"TaggedTemplateExpression[tag.name='sql'] NewExpression[callee.name='Date'][arguments.length=0]",
		message: appClockStamp
	},
	{
		// A selector cannot follow a variable into a later .set() or .values(),
		// so server code does not hold the app clock in one at all.
		selector: "VariableDeclarator > NewExpression.init[callee.name='Date'][arguments.length=0]",
		message:
			'Do not keep new Date() in a variable in server code. For a stored time use sql`now()` or dbNow(); to compare, write new Date() where it is compared.'
	}
];

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	},
	{
		// Forms use #lib/enhance, which keeps a result on the submitting page.
		files: ['src/**'],
		ignores: ['src/lib/enhance.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: [
						{
							name: '$app/forms',
							importNames: ['enhance'],
							message: 'Import enhance from #lib/enhance instead.'
						}
					]
				}
			]
		}
	},
	{
		files: ['src/**'],
		ignores: ['src/lib/format.ts'],
		rules: { 'no-restricted-syntax': ['error', ...fixedLocale] }
	},
	{
		// A later block replaces no-restricted-syntax rather than adding to it,
		// so server code repeats the locale rules.
		files: ['src/lib/server/**', 'src/routes/**/*.ts', 'src/worker/**'],
		rules: { 'no-restricted-syntax': ['error', ...fixedLocale, ...oneClock] }
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	}
);
