import { describe, expect, it } from 'vitest';
import {
	assertUploadStateTransition,
	isUploadSessionState,
} from '../modules/admin/game-upload/state-machine.js';

describe('game upload state machine', () => {
	it.each([
		['PENDING', 'COMPLETING'],
		['PENDING', 'CANCELLED'],
		['PENDING', 'FAILED'],
		['COMPLETING', 'PENDING'],
		['COMPLETING', 'COMPLETED'],
		['COMPLETING', 'FAILED'],
	] as const)('allows %s -> %s', (current, next) => {
		expect(() => assertUploadStateTransition(current, next)).not.toThrow();
	});

	it.each([
		['COMPLETED', 'PENDING'],
		['FAILED', 'COMPLETING'],
		['CANCELLED', 'COMPLETING'],
		['UNKNOWN', 'FAILED'],
	] as const)('rejects %s -> %s', (current, next) => {
		expect(() => assertUploadStateTransition(current, next)).toThrowError(
			/Cannot transition upload session/,
		);
	});

	it('recognizes only persisted states', () => {
		expect(isUploadSessionState('COMPLETING')).toBe(true);
		expect(isUploadSessionState('RETRYING')).toBe(false);
	});
});
