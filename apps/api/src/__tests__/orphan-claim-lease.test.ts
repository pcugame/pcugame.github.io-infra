import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOrphanClaimLeaseGuard } from '../modules/orphan/claim-lease-guard.js';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('orphan claim lease guard', () => {
	it('waits for the first heartbeat tick and stops scheduling renewals', async () => {
		vi.useFakeTimers();
		const renew = vi.fn(async () => ({ count: 1 }));
		const guard = createOrphanClaimLeaseGuard({
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => new Error('claim lost'),
			renew,
			logHeartbeatFailure: vi.fn(),
		});

		expect(renew).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(29_999);
		expect(renew).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(renew).toHaveBeenCalledOnce();

		guard.stop();
		guard.stop();
		await vi.advanceTimersByTimeAsync(90_000);
		expect(renew).toHaveBeenCalledOnce();
	});

	it('accepts an explicit renewal only when exactly one claim is still owned', async () => {
		const success = createOrphanClaimLeaseGuard({
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => new Error('claim lost'),
			renew: vi.fn(async () => ({ count: 1 })),
			logHeartbeatFailure: vi.fn(),
		});
		await expect(success.renewAndAssertOwned()).resolves.toBeUndefined();
		expect(success.signal.aborted).toBe(false);
		success.stop();

		const lostError = new Error('claim lost');
		const lost = createOrphanClaimLeaseGuard({
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => lostError,
			renew: vi.fn(async () => ({ count: 0 })),
			logHeartbeatFailure: vi.fn(),
		});
		await expect(lost.renewAndAssertOwned()).rejects.toBe(lostError);
		expect(lost.signal.aborted).toBe(true);
		expect(lost.signal.reason).toBe(lostError);
		expect(() => lost.assertLeaseUsable()).toThrow(lostError);
		lost.stop();
	});

	it('coalesces an explicit renewal with an overlapping heartbeat flight', async () => {
		vi.useFakeTimers();
		let resolveRenewal!: (result: { count: number }) => void;
		const pendingRenewal = new Promise<{ count: number }>((resolve) => {
			resolveRenewal = resolve;
		});
		const renew = vi.fn(() => pendingRenewal);
		const logHeartbeatFailure = vi.fn();
		const guard = createOrphanClaimLeaseGuard({
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => new Error('claim lost'),
			renew,
			logHeartbeatFailure,
		});

		await vi.advanceTimersByTimeAsync(30_000);
		expect(renew).toHaveBeenCalledOnce();
		const explicitRenewal = guard.renewAndAssertOwned();
		expect(renew).toHaveBeenCalledOnce();

		resolveRenewal({ count: 1 });
		await expect(explicitRenewal).resolves.toBeUndefined();
		expect(logHeartbeatFailure).not.toHaveBeenCalled();
		guard.stop();
	});

	it('fails closed at the renewal deadline and fences a late fulfillment', async () => {
		vi.useFakeTimers();
		const deadlineReason = new DOMException('renewal deadline', 'TimeoutError');
		const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(deadlineReason), delay);
			return controller.signal;
		});
		let resolveRenewal!: (result: { count: number }) => void;
		const renew = vi.fn((_signal: AbortSignal) => (
			new Promise<{ count: number }>((resolve) => { resolveRenewal = resolve; })
		));
		let repositorySignal: AbortSignal | undefined;
		const guard = createOrphanClaimLeaseGuard({
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => new Error('claim lost'),
			renew: (signal) => {
				repositorySignal = signal;
				return renew(signal);
			},
			logHeartbeatFailure: vi.fn(),
		});

		const flight = guard.renewAndAssertOwned();
		const flightRejection = expect(flight).rejects.toBe(deadlineReason);
		expect(timeoutSpy).toHaveBeenCalledWith(60_000);
		expect(repositorySignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000);
		await flightRejection;
		expect(repositorySignal?.aborted).toBe(true);
		expect(guard.signal.reason).toBe(deadlineReason);

		resolveRenewal({ count: 1 });
		await Promise.resolve();
		await expect(guard.renewAndAssertOwned()).rejects.toBe(deadlineReason);
		expect(renew).toHaveBeenCalledOnce();
		guard.stop();
	});

	it('settles a pending renewal on outer abort without relabelling it as claim loss', async () => {
		const controller = new AbortController();
		const outerReason = new Error('shutdown');
		let repositorySignal: AbortSignal | undefined;
		const renew = vi.fn((signal: AbortSignal) => {
			repositorySignal = signal;
			return new Promise<{ count: number }>(() => {});
		});
		const guard = createOrphanClaimLeaseGuard({
			outerSignal: controller.signal,
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => new Error('claim lost'),
			renew,
			logHeartbeatFailure: vi.fn(),
		});

		const flight = guard.renewAndAssertOwned();
		expect(repositorySignal?.aborted).toBe(false);
		controller.abort(outerReason);
		await expect(flight).rejects.toBe(outerReason);
		expect(repositorySignal?.aborted).toBe(true);
		expect(() => guard.assertLeaseUsable()).not.toThrow();
		expect(() => guard.assertOperationActive()).toThrow(outerReason);
		guard.stop();
	});

	it('does not authorize a renewal result delivered after the outer signal aborts', async () => {
		const controller = new AbortController();
		const outerReason = new Error('shutdown before renewal result');
		const renew = vi.fn(async () => {
			controller.abort(outerReason);
			return { count: 1 };
		});
		const guard = createOrphanClaimLeaseGuard({
			outerSignal: controller.signal,
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => new Error('claim lost'),
			renew,
			logHeartbeatFailure: vi.fn(),
		});

		await expect(guard.renewAndAssertOwned()).rejects.toBe(outerReason);
		expect(() => guard.assertLeaseUsable()).not.toThrow();
		guard.stop();
	});

	it('observes a database rejection that arrives after an outer abort', async () => {
		const controller = new AbortController();
		let rejectRenewal!: (error: Error) => void;
		const renew = vi.fn(() => new Promise<{ count: number }>((_resolve, reject) => {
			rejectRenewal = reject;
		}));
		const guard = createOrphanClaimLeaseGuard({
			outerSignal: controller.signal,
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => new Error('claim lost'),
			renew,
			logHeartbeatFailure: vi.fn(),
		});
		const unhandledRejection = vi.fn();
		process.on('unhandledRejection', unhandledRejection);

		try {
			const flight = guard.renewAndAssertOwned();
			controller.abort(new Error('shutdown'));
			await expect(flight).rejects.toBe(controller.signal.reason);

			rejectRenewal(new Error('late database rejection'));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandledRejection).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandledRejection);
			guard.stop();
		}
	});

	it('preserves the first renewal error identity across repeated assertions', async () => {
		const firstError = new Error('database timeout');
		const renew = vi.fn(async () => {
			throw firstError;
		});
		const guard = createOrphanClaimLeaseGuard({
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => new Error('claim lost'),
			renew,
			logHeartbeatFailure: vi.fn(),
		});

		await expect(guard.renewAndAssertOwned()).rejects.toBe(firstError);
		expect(guard.signal.reason).toBe(firstError);
		await expect(guard.renewAndAssertOwned()).rejects.toBe(firstError);
		expect(renew).toHaveBeenCalledOnce();
		guard.stop();
		guard.stop();
	});

	it('normalizes a non-Error renewal failure once and keeps that reason latched', async () => {
		const renew = vi.fn(() => Promise.reject('database unavailable'));
		const guard = createOrphanClaimLeaseGuard({
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => new Error('claim lost'),
			renew,
			logHeartbeatFailure: vi.fn(),
		});

		let normalized: unknown;
		try {
			await guard.renewAndAssertOwned();
		} catch (error) {
			normalized = error;
		}
		expect(normalized).toBeInstanceOf(Error);
		expect(normalized).toMatchObject({ message: 'database unavailable' });
		expect(guard.signal.reason).toBe(normalized);
		await expect(guard.renewAndAssertOwned()).rejects.toBe(normalized);
		expect(renew).toHaveBeenCalledOnce();
		guard.stop();
	});

	it('does not latch a pending heartbeat failure after the guard is stopped', async () => {
		vi.useFakeTimers();
		let rejectLateRenewal!: (error: Error) => void;
		const logHeartbeatFailure = vi.fn();
		const lateGuard = createOrphanClaimLeaseGuard({
			heartbeatMs: 30_000,
			renewalDeadlineMs: 60_000,
			ownershipLostError: () => new Error('claim lost'),
			renew: () => new Promise<{ count: number }>((_resolve, reject) => {
				rejectLateRenewal = reject;
			}),
			logHeartbeatFailure,
		});
		await vi.advanceTimersByTimeAsync(30_000);
		lateGuard.stop();
		rejectLateRenewal(new Error('late failure after stop'));
		await vi.advanceTimersByTimeAsync(0);
		expect(lateGuard.signal.aborted).toBe(false);
		expect(() => lateGuard.assertLeaseUsable()).not.toThrow();
		expect(logHeartbeatFailure).toHaveBeenCalledOnce();
	});
});
