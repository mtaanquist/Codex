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
		// Forms use $lib/enhance, which keeps a result on the submitting page.
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
							message: 'Import enhance from $lib/enhance instead.'
						}
					]
				}
			]
		}
	},
	{
		// Display formatting goes through $lib/format so the locale stays fixed.
		files: ['src/**'],
		ignores: ['src/lib/format.ts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector:
						'CallExpression[callee.property.name=/^toLocale(String|DateString|TimeString)$/]',
					message: 'Use a $lib/format helper so the display locale stays fixed.'
				},
				{
					selector:
						":matches(NewExpression, CallExpression)[callee.object.name='Intl'][callee.property.name=/^(DateTimeFormat|NumberFormat|RelativeTimeFormat|ListFormat|PluralRules)$/]",
					message: 'Use a $lib/format helper so the display locale stays fixed.'
				}
			]
		}
	},
	{
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		rules: {}
	}
);
