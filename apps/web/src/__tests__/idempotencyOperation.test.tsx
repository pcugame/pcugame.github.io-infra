// @vitest-environment jsdom
import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
	createIdempotencyFingerprint,
	createStableIdempotencyOperation,
	fingerprintFile,
	useStableIdempotencyOperation,
} from '../lib/idempotency-operation';

function createWrapper() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retryDelay: 0 } },
	});
	return function Wrapper({ children }: PropsWithChildren) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};
}

function useRetryingLogicalMutation(
	payload: { title: string },
	file: File,
	request: (idempotencyKey: string) => Promise<void>,
) {
	const operation = useStableIdempotencyOperation();
	const mutation = useMutation({
		mutationFn: ({ idempotencyKey }: { idempotencyKey: string; fingerprint: string }) => (
			request(idempotencyKey)
		),
		retry: (failureCount) => failureCount < 1,
		retryDelay: 0,
		onSuccess: (_result, variables) => operation.complete(variables.fingerprint),
	});
	return () => {
		const fingerprint = createIdempotencyFingerprint({
			payload,
			file: fingerprintFile(file),
		});
		mutation.mutate({
			fingerprint,
			idempotencyKey: operation.keyFor(fingerprint),
		});
	};
}

describe('stable idempotency operation', () => {
	it('reuses one key for the initial request, React Query retry, and same-input manual retry', async () => {
		const keys: string[] = [];
		const request = vi.fn(async (key: string) => {
			keys.push(key);
			if (keys.length < 3) throw new Error('ambiguous network failure');
		});
		const file = new File(['poster'], 'poster.png', {
			type: 'image/png',
			lastModified: 123,
		});
		const { result } = renderHook(
			() => useRetryingLogicalMutation({ title: 'same' }, file, request),
			{ wrapper: createWrapper() },
		);

		act(() => result.current());
		await waitFor(() => expect(request).toHaveBeenCalledTimes(2));

		act(() => result.current());
		await waitFor(() => expect(request).toHaveBeenCalledTimes(3));

		expect(new Set(keys).size).toBe(1);
	});

	it('rotates the key when payload or file metadata changes', () => {
		const operation = createStableIdempotencyOperation(
			vi.fn()
				.mockReturnValueOnce('key-1')
				.mockReturnValueOnce('key-2')
				.mockReturnValueOnce('key-3'),
		);
		const base = createIdempotencyFingerprint({
			payload: { title: 'one' },
			file: { name: 'game.zip', size: 10, type: 'application/zip', lastModified: 1 },
		});
		const changedPayload = createIdempotencyFingerprint({
			payload: { title: 'two' },
			file: { name: 'game.zip', size: 10, type: 'application/zip', lastModified: 1 },
		});
		const changedFile = createIdempotencyFingerprint({
			payload: { title: 'two' },
			file: { name: 'game-v2.zip', size: 11, type: 'application/zip', lastModified: 2 },
		});

		expect(operation.keyFor(base)).toBe('key-1');
		expect(operation.keyFor(base)).toBe('key-1');
		expect(operation.keyFor(changedPayload)).toBe('key-2');
		expect(operation.keyFor(changedFile)).toBe('key-3');
	});

	it('discards the completed operation so a new successful-workflow start gets a new key', () => {
		const operation = createStableIdempotencyOperation(
			vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2'),
		);
		const fingerprint = createIdempotencyFingerprint({ projectId: 7, kind: 'IMAGE' });

		expect(operation.keyFor(fingerprint)).toBe('key-1');
		operation.complete(fingerprint);
		expect(operation.keyFor(fingerprint)).toBe('key-2');
	});
});
