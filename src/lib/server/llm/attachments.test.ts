import { describe, it, expect } from 'vitest';
import { fitShares, foldAttachments, noteAttachments } from './attachments';

const id = '11111111-1111-4111-8111-111111111111';

describe('fitShares', () => {
	it('keeps everything when it fits', () => {
		expect(fitShares([10, 20], 100)).toEqual([10, 20]);
	});

	it('keeps the small ones whole and splits the rest between the large ones', () => {
		expect(fitShares([10, 1000, 1000], 210)).toEqual([10, 100, 100]);
		expect(fitShares([1000, 10], 110)).toEqual([100, 10]);
	});
});

describe('foldAttachments', () => {
	it('puts the attachments in front of the message', () => {
		const folded = foldAttachments('What happens here?', [
			{ attachment: { kind: 'scene', id, label: 'Gate' }, title: 'Scene "Gate"', text: 'The gate.' }
		]);
		expect(folded).toContain('<attachment title="Scene \'Gate\'">\nThe gate.\n</attachment>');
		expect(folded.endsWith('What happens here?')).toBe(true);
	});

	it('leaves a message without attachments alone', () => {
		expect(foldAttachments('Hi.', [])).toBe('Hi.');
	});
});

describe('noteAttachments', () => {
	it('names what an earlier message carried', () => {
		expect(noteAttachments('Hi.', [{ kind: 'entity', id, label: 'Mira' }])).toBe(
			'Hi.\n\n(The writer attached entity "Mira" to this message.)'
		);
	});
});
