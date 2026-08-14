import type {
	ObjectKeyDeleteFailure,
	ObjectStorage,
	StorageRequestOptions,
} from './ports.js';

const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_MAX_LIST_PAGES = 1_000;

export class PrefixDeletionStorageError extends Error {
	constructor(
		readonly operation: 'list' | 'delete',
		cause: unknown,
		readonly processed: number,
	) {
		super(`Prefix deletion ${operation} request failed`, { cause });
		this.name = 'PrefixDeletionStorageError';
	}
}

export class PrefixDeletionPageBudgetError extends Error {
	constructor(readonly maxListPages: number, readonly processed: number) {
		super(`Prefix deletion exhausted its ${maxListPages}-page attempt budget`);
		this.name = 'PrefixDeletionPageBudgetError';
	}
}

export interface PrefixDeletionResult {
	/** Keys conclusively accounted for in submitted batches (including queued failures). */
	processed: number;
	pages: number;
}

/**
 * Bounded, mutation-safe prefix deletion using S3's lexical StartAfter cursor.
 * It retains only a current page/batch and never deduplicates across pages; a
 * successful response counts that batch's confirmed keys, as did the legacy
 * prefix coordinator's per-key completion count.
 */
export async function deletePrefixPages(input: {
	storage: {
		listKeyPage: NonNullable<ObjectStorage['listKeyPage']>;
		deleteKeys: NonNullable<ObjectStorage['deleteKeys']>;
	};
	bucket: string;
	prefix: string;
	pageSize?: number;
	maxListPages?: number;
	request?: StorageRequestOptions;
	createRequest?: () => StorageRequestOptions;
	beforeList?: () => Promise<void> | void;
	beforeDelete?: () => Promise<void> | void;
	onFailures?: (failures: readonly ObjectKeyDeleteFailure[]) => Promise<void> | void;
}): Promise<PrefixDeletionResult> {
	const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
	const maxListPages = input.maxListPages ?? DEFAULT_MAX_LIST_PAGES;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > DEFAULT_PAGE_SIZE) {
		throw new RangeError('prefix deletion pageSize must be an integer between 1 and 1000');
	}
	if (!Number.isInteger(maxListPages) || maxListPages < 1) {
		throw new RangeError('prefix deletion maxListPages must be a positive integer');
	}
	if (maxListPages < pageSize) {
		throw new RangeError('prefix deletion maxListPages must be at least pageSize');
	}
	if (input.request !== undefined && input.createRequest !== undefined) {
		throw new TypeError('prefix deletion accepts either request or createRequest, not both');
	}

	let startAfter: string | undefined;
	let pages = 0;
	let processed = 0;
	let hadRecordedPartialFailure = false;
	let pendingBatch: string[] = [];
	const requestForOperation = () => input.createRequest?.() ?? input.request;
	const assertRequestActive = (request: StorageRequestOptions | undefined) => {
		if (request?.signal?.aborted) {
			throw request.signal.reason ?? new Error('Prefix deletion storage request aborted');
		}
	};

	const list = async (page: { startAfter?: string; maxKeys: number }) => {
		if (pages >= maxListPages) {
			// Do not strand a sub-batch when a backend returns legally short pages.
			// Flushing before the retryable budget outcome guarantees bounded
			// progress when the page cap lands on a pending sub-batch.
			await flush(true);
			throw new PrefixDeletionPageBudgetError(maxListPages, processed);
		}
		await input.beforeList?.();
		try {
			const request = requestForOperation();
			assertRequestActive(request);
			const result = await input.storage.listKeyPage(input.bucket, input.prefix, page, request);
			// Some adapters can resolve after their signal has timed out or been
			// aborted. Do not accept that stale result as deletion progress.
			assertRequestActive(request);
			pages++;
			return result;
		} catch (error) {
			throw new PrefixDeletionStorageError('list', error, processed);
		}
	};

	const flush = async (all: boolean) => {
		while (pendingBatch.length >= pageSize || (all && pendingBatch.length > 0)) {
			const batch = pendingBatch.splice(0, Math.min(pageSize, pendingBatch.length));
			await input.beforeDelete?.();
			let outcome;
			try {
				const request = requestForOperation();
				assertRequestActive(request);
				outcome = await input.storage.deleteKeys(input.bucket, batch, request);
				// A possibly-applied batch whose request timed out remains retryable;
				// it must not contribute to a terminal success in this attempt.
				assertRequestActive(request);
			} catch (error) {
				throw new PrefixDeletionStorageError('delete', error, processed);
			}
			processed += batch.length;
			if (outcome.failures.length > 0) {
				await input.onFailures?.(outcome.failures);
				hadRecordedPartialFailure = true;
			}
		}
	};

	for (;;) {
		const page = await list({
			...(startAfter !== undefined ? { startAfter } : {}),
			maxKeys: pageSize,
		});
		if (page.keys.length === 0) {
			if (page.isTruncated) {
				throw new PrefixDeletionStorageError('list', new Error('empty truncated key page'), processed);
			}
			await flush(true);
			if (hadRecordedPartialFailure || startAfter === undefined) return { processed, pages };
			const fresh = await list({ maxKeys: 1 });
			if (fresh.keys.length === 0 && !fresh.isTruncated) return { processed, pages };
			if (fresh.keys.length === 0) {
				throw new PrefixDeletionStorageError('list', new Error('empty truncated key page'), processed);
			}
			startAfter = undefined;
			continue;
		}

		pendingBatch.push(...page.keys);
		startAfter = page.keys.at(-1);
		// Page shape is not a batch boundary: every truncated page contributes to
		// one bounded lexical batch, including a one-key short page.
		if (pendingBatch.length >= pageSize || !page.isTruncated) {
			await flush(!page.isTruncated);
		}
		if (page.isTruncated) continue;
		if (hadRecordedPartialFailure) return { processed, pages };

		// A terminal page is only a point-in-time observation. Verify the prefix
		// head after deletion before reporting all-confirmed success.
		const fresh = await list({ maxKeys: 1 });
		if (fresh.keys.length === 0 && !fresh.isTruncated) return { processed, pages };
		if (fresh.keys.length === 0) {
			throw new PrefixDeletionStorageError('list', new Error('empty truncated key page'), processed);
		}
		startAfter = undefined;
	}
}
