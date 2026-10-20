import { describe, expect, it } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { throwActionError, type ActionFailure } from './action-result';

function statusOf(result: ActionFailure) {
	try {
		throwActionError(result);
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, message: err.body.message };
		throw err;
	}
}

describe('throwActionError', () => {
	it('maps on the code, not the wording of the reason', () => {
		expect(
			statusOf({ ok: false, code: 'not_found', reason: 'That scene does not exist.' })
		).toEqual({ status: 404, message: 'That scene does not exist.' });
		expect(statusOf({ ok: false, code: 'invalid', reason: 'Nothing was found to mark.' })).toEqual({
			status: 400,
			message: 'Nothing was found to mark.'
		});
		expect(
			statusOf({ ok: false, code: 'conflict', reason: 'That relationship already exists.' })
		).toEqual({ status: 409, message: 'That relationship already exists.' });
	});
});
