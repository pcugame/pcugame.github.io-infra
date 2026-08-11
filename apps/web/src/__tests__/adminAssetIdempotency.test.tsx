// @vitest-environment jsdom
import type { PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAdminProjectMutations } from '../features/admin/projects/useAdminProjectMutations';
import { adminProjectApi, ApiError } from '../lib/api';

function wrapper() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retryDelay: 0 },
		},
	});
	return function Wrapper({ children }: PropsWithChildren) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};
}

afterEach(() => vi.restoreAllMocks());

describe('admin asset logical-operation idempotency', () => {
	it('reuses the key across automatic and manual network retries, then rotates on success or file change', async () => {
		const keys: string[] = [];
		const addAsset = vi.spyOn(adminProjectApi, 'addAsset').mockImplementation(async (input) => {
			keys.push(input.idempotencyKey);
			if (keys.length < 3) throw new ApiError(0, 'Network Error', null);
			return { assetId: keys.length, url: 'https://assets.test/image.webp' };
		});
		const original = new File(['image'], 'image.png', {
			type: 'image/png',
			lastModified: 100,
		});
		const changed = new File(['image-v2'], 'image-v2.png', {
			type: 'image/png',
			lastModified: 200,
		});
		const { result } = renderHook(
			() => useAdminProjectMutations({ projectId: 7 }),
			{ wrapper: wrapper() },
		);

		await act(async () => {
			await expect(result.current.addAsset('IMAGE', original)).rejects.toBeInstanceOf(ApiError);
		});
		expect(addAsset).toHaveBeenCalledTimes(2);

		await act(async () => {
			await expect(result.current.addAsset('IMAGE', original)).resolves.toBeUndefined();
		});
		expect(addAsset).toHaveBeenCalledTimes(3);
		expect(new Set(keys.slice(0, 3)).size).toBe(1);

		await act(async () => {
			await result.current.addAsset('IMAGE', original);
			await result.current.addAsset('IMAGE', changed);
		});
		expect(keys[3]).not.toBe(keys[2]);
		expect(keys[4]).not.toBe(keys[3]);
	});
});
