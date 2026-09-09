import { describe, expect, it } from 'vitest';
import { parseContractPreflightCli } from './preflight-canonical-contract.js';
import { CONTRACT_PREFLIGHT_RESET_CONFIRMATION } from '../src/modules/migration/contract-preflight.js';

describe('observation age exception CLI', () => {
	it('defaults to normal observation and requires an explicit named exception', () => {
		expect(parseContractPreflightCli([]).observationWindowMs).toBeUndefined();
		expect(parseContractPreflightCli(['--observation-exception-id=reviewed-20260910'])).toMatchObject({ observationWindowMs: 0, observationExceptionId: 'reviewed-20260910', resetObservation: false });
	});
	it('rejects malformed IDs and metric reset with an exception', () => {
		expect(() => parseContractPreflightCli(['--observation-exception-id='])).toThrow('observation-exception-id');
		expect(() => parseContractPreflightCli(['--observation-exception-id=../unsafe'])).toThrow('observation-exception-id');
		expect(() => parseContractPreflightCli(['--observation-exception-id=reviewed-20260910', '--reset-observation', `--confirm-reset=${CONTRACT_PREFLIGHT_RESET_CONFIRMATION}`])).toThrow('must not reset');
	});
});
