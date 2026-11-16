import { describe, it, expect } from 'vitest';
import { draftCrumb, storyPath } from './chrome';

const universe = { slug: 'saltlands', name: 'Saltlands' };
const story = { slug: 'salt-road', title: 'The Salt Road' };
const drafts = [
	{ id: '00000000-0000-4000-8000-000000000002', label: 'Second draft' },
	{ id: '00000000-0000-4000-8000-000000000001', label: 'First draft' }
];

describe('the drafts crumb', () => {
	it('is left out until the story has a saved draft', () => {
		const path = storyPath(universe, story, { drafts: { list: [], at: null } });
		expect(path.map((crumb) => crumb.label)).toEqual(['Library', 'Saltlands', 'The Salt Road']);
	});

	it('names the working draft and lists every saved draft', () => {
		const path = storyPath(universe, story, { drafts: { list: drafts, at: null } });
		const crumb = path[path.length - 1];
		expect(crumb).toMatchObject({ kind: 'place', label: 'Working draft', keepParent: true });
		if (crumb.kind !== 'place') return;
		expect(crumb.groups.map((group) => group.map((item) => item.label))).toEqual([
			['Working draft'],
			['Second draft', 'First draft'],
			['Save as draft...']
		]);
		expect(crumb.groups[0][0]).toMatchObject({ href: '/stories/salt-road', current: true });
		expect(crumb.groups[2][0].href).toBe('/stories/salt-road/settings/drafts');
	});

	it('names and ticks the open draft', () => {
		const crumb = draftCrumb(story, { list: drafts, at: drafts[1].id });
		expect(crumb.label).toBe('First draft');
		if (crumb.kind !== 'place') return;
		expect(crumb.groups[0][0].current).toBe(false);
		expect(crumb.groups[1].find((item) => item.current)).toMatchObject({
			label: 'First draft',
			href: `/stories/salt-road/drafts/${drafts[1].id}`
		});
	});
});
