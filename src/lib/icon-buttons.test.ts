import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// An icon-only button or link has no visible text, so it needs an aria-label
// (design-system.md, Buttons). `title` alone shows only on mouse hover.
const root = join(process.cwd(), 'src');

// The end of an opening tag, skipping `>` inside quotes and `{...}`
// expressions (`onclick={() => x}`).
function tagEnd(text: string, from: number): number {
	let depth = 0;
	let quote = '';
	for (let i = from; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = '';
		} else if (ch === '{') depth++;
		else if (ch === '}') depth--;
		else if (depth === 0 && (ch === '"' || ch === "'")) quote = ch;
		else if (depth === 0 && ch === '>') return i;
	}
	return -1;
}

// What is left of a control's body once tags and Svelte block markers
// ({#if}, {:else}, {/if}) are gone. An `{expression}` counts as text.
function visibleText(body: string): string {
	let out = '';
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '<') {
			const end = tagEnd(body, i);
			if (end < 0) break;
			i = end;
		} else out += body[i];
	}
	return out.replace(/\{[#:/@][^}]*\}/g, '').trim();
}

function unlabelledIconControls(source: string): string[] {
	const text = source.replace(/<!--[\s\S]*?-->/g, '');
	const found: string[] = [];
	const open = /<(button|a)(?=[\s>])/g;
	let match: RegExpExecArray | null;
	while ((match = open.exec(text))) {
		const tag = match[1];
		const end = tagEnd(text, match.index);
		if (end < 0) break;
		const attrs = text.slice(match.index, end + 1);
		if (attrs.endsWith('/>')) continue;
		const close = text.indexOf(`</${tag}>`, end);
		if (close < 0) continue;
		const body = text.slice(end + 1, close);
		if (visibleText(body) === '' && !/\saria-label(ledby)?=/.test(attrs)) {
			found.push(attrs.replace(/\s+/g, ' '));
		}
	}
	return found;
}

function svelteFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return svelteFiles(path);
		return entry.name.endsWith('.svelte') ? [path] : [];
	});
}

describe('icon-only controls', () => {
	it('flags a button with only an icon and no aria-label', () => {
		const src = `
			<button onclick={() => (open = x > 1)} title="Bold"><Icon name="bold" /></button>
			<button aria-label="Italic" title="Italic"><Icon name="italic" /></button>
			<button><Icon name="plus" /> Add</button>
			<a href="/x" title="Story view">
				<Icon name="book" size={14} />
			</a>
			<button title="Mark done" onclick={done}></button>
			<button title="Badge">{#if image}<img src={image} alt="" />{:else}<EntityBadge {name} />{/if}</button>
			<button>{item.title}</button>
			<aside><Icon name="x" /></aside>`;
		expect(unlabelledIconControls(src)).toEqual([
			'<button onclick={() => (open = x > 1)} title="Bold">',
			'<a href="/x" title="Story view">',
			'<button title="Mark done" onclick={done}>',
			'<button title="Badge">'
		]);
	});

	it('every icon-only button and link carries an aria-label', () => {
		const problems = svelteFiles(root).flatMap((file) =>
			unlabelledIconControls(readFileSync(file, 'utf8')).map(
				(tag) => `${relative(root, file)}: ${tag}`
			)
		);
		expect(problems).toEqual([]);
	});
});
