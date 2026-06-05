import { describe, it, expect } from 'vitest';
import {
	buildWeb,
	layoutWeb,
	webCategories,
	type WebEntity,
	type WebLink
} from './relationship-web';

const entities: WebEntity[] = [
	{ id: 'a', type: 'character', name: 'Alice', color: null },
	{ id: 'b', type: 'character', name: 'Bram', color: '#123456' },
	{ id: 'c', type: 'place', name: 'Citadel', color: null },
	{ id: 'd', type: 'lore_entry', name: 'Dawn rite', color: null }
];

const links: WebLink[] = [
	{ id: 'l1', fromId: 'a', toId: 'b', label: 'sibling of', category: 'family' },
	{ id: 'l2', fromId: 'a', toId: 'c', label: 'lives in', category: 'geography' },
	{ id: 'l3', fromId: 'b', toId: 'c', label: 'rules', category: 'geography' },
	{ id: 'l4', fromId: 'a', toId: 'd', label: 'keeper of', category: null }
];

describe('webCategories', () => {
	it('lists present categories in a stable order, nulls as other', () => {
		expect(webCategories(links)).toEqual(['family', 'geography', 'other']);
		expect(webCategories(links.slice(0, 1))).toEqual(['family']);
	});
});

describe('buildWeb', () => {
	it('keeps every connected entity with its degree', () => {
		const web = buildWeb(entities, links);
		expect(web.links).toHaveLength(4);
		expect(web.nodes.map((node) => [node.id, node.degree])).toEqual([
			['a', 3],
			['b', 2],
			['c', 2],
			['d', 1]
		]);
	});

	it('drops isolated entities', () => {
		const web = buildWeb(
			[...entities, { id: 'e', type: 'character' as const, name: 'Eremon', color: null }],
			links
		);
		expect(web.nodes.find((node) => node.id === 'e')).toBeUndefined();
	});

	it('filters by category, null bucketing as other', () => {
		const geography = buildWeb(entities, links, { categories: new Set(['geography']) });
		expect(geography.links.map((link) => link.id)).toEqual(['l2', 'l3']);
		expect(geography.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
		const other = buildWeb(entities, links, { categories: new Set(['other']) });
		expect(other.links.map((link) => link.id)).toEqual(['l4']);
	});

	it('focus keeps the entity and its direct connections only', () => {
		const web = buildWeb(entities, links, { focusId: 'b' });
		expect(web.links.map((link) => link.id)).toEqual(['l1', 'l3']);
		expect(web.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
	});

	it('focus and category compose', () => {
		const web = buildWeb(entities, links, {
			focusId: 'a',
			categories: new Set(['family'])
		});
		expect(web.links.map((link) => link.id)).toEqual(['l1']);
		expect(web.nodes.map((node) => node.id)).toEqual(['a', 'b']);
	});
});

describe('layoutWeb', () => {
	it('places every node inside the frame and wires link endpoints', () => {
		const web = buildWeb(entities, links);
		const placed = layoutWeb(web.nodes, web.links, 800, 520);
		expect(placed.nodes).toHaveLength(4);
		for (const node of placed.nodes) {
			expect(node.x).toBeGreaterThanOrEqual(30);
			expect(node.x).toBeLessThanOrEqual(770);
			expect(node.y).toBeGreaterThanOrEqual(30);
			expect(node.y).toBeLessThanOrEqual(490);
		}
		const byId = new Map(placed.nodes.map((node) => [node.id, node]));
		for (const link of placed.links) {
			expect(link.x1).toBe(byId.get(link.fromId)!.x);
			expect(link.y2).toBe(byId.get(link.toId)!.y);
		}
	});

	it('is deterministic for the same input', () => {
		const web = buildWeb(entities, links);
		const first = layoutWeb(web.nodes, web.links, 800, 520);
		const second = layoutWeb(web.nodes, web.links, 800, 520);
		expect(second.nodes).toEqual(first.nodes);
	});

	it('connected nodes sit apart, not stacked', () => {
		const web = buildWeb(entities, links);
		const placed = layoutWeb(web.nodes, web.links, 800, 520);
		const [a, b] = placed.nodes;
		const distance = Math.hypot(a.x - b.x, a.y - b.y);
		expect(distance).toBeGreaterThan(40);
	});
});
