import { describe, it, expect } from 'vitest';
import {
	cleanDetails,
	snapshotsEqual,
	MAX_DETAILS,
	MAX_DETAIL_LABEL,
	MAX_DETAIL_VALUE,
	type EntitySnapshot
} from './entity-snapshot';

describe('cleanDetails', () => {
	it('returns an empty list for anything that is not an array', () => {
		expect(cleanDetails(undefined)).toEqual([]);
		expect(cleanDetails(null)).toEqual([]);
		expect(cleanDetails('Status: Alive')).toEqual([]);
		expect(cleanDetails({ label: 'Status', value: 'Alive' })).toEqual([]);
	});

	it('trims strings and keeps the author order', () => {
		expect(
			cleanDetails([
				{ label: '  Status ', value: ' Alive ' },
				{ label: 'Age', value: '32' }
			])
		).toEqual([
			{ label: 'Status', value: 'Alive' },
			{ label: 'Age', value: '32' }
		]);
	});

	it('drops rows missing a label or value, and non-string rows', () => {
		expect(
			cleanDetails([
				{ label: 'Status', value: '' },
				{ label: '  ', value: 'Alive' },
				{ label: 'Age', value: 32 },
				'Allegiance: None',
				null,
				{ label: 'Born', value: 'Halden' }
			])
		).toEqual([{ label: 'Born', value: 'Halden' }]);
	});

	it('caps the row count and the string lengths', () => {
		const rows = Array.from({ length: MAX_DETAILS + 5 }, (_, index) => ({
			label: `Label ${index}`,
			value: 'x'
		}));
		expect(cleanDetails(rows)).toHaveLength(MAX_DETAILS);

		const [long] = cleanDetails([
			{ label: 'L'.repeat(MAX_DETAIL_LABEL + 10), value: 'V'.repeat(MAX_DETAIL_VALUE + 10) }
		]);
		expect(long.label).toHaveLength(MAX_DETAIL_LABEL);
		expect(long.value).toHaveLength(MAX_DETAIL_VALUE);
	});
});

describe('snapshotsEqual', () => {
	const snapshot = (): EntitySnapshot => ({
		name: 'Alice',
		aliases: ['Allie'],
		summaryMd: 'A smuggler.',
		categoryId: null,
		categoryName: null,
		details: [{ label: 'Status', value: 'Alive' }],
		relationships: []
	});

	it('treats null as equal only to null', () => {
		expect(snapshotsEqual(null, null)).toBe(true);
		expect(snapshotsEqual(snapshot(), null)).toBe(false);
		expect(snapshotsEqual(null, snapshot())).toBe(false);
	});

	it('compares structurally', () => {
		expect(snapshotsEqual(snapshot(), snapshot())).toBe(true);
		const changed = snapshot();
		changed.details[0].value = 'Missing';
		expect(snapshotsEqual(snapshot(), changed)).toBe(false);
	});

	it('ignores object key order, as Postgres jsonb does not keep it', () => {
		const reordered = JSON.parse(
			'{"relationships":[],"details":[{"value":"Alive","label":"Status"}],"categoryName":null,"categoryId":null,"summaryMd":"A smuggler.","aliases":["Allie"],"name":"Alice"}'
		) as EntitySnapshot;
		expect(snapshotsEqual(snapshot(), reordered)).toBe(true);
	});
});
