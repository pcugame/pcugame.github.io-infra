import type { SourceFileIdentity } from './file-identity-core';

export {
	SOURCE_IDENTITY_ALGORITHM,
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
} from './file-identity-core';
export type { SourceFileIdentity as FileIdentity } from './file-identity-core';

export interface ComputeFileIdentityOptions {
	signal?: AbortSignal;
}

type WorkerResult =
	| { type: 'success'; identity: SourceFileIdentity }
	| { type: 'error'; message: string };

/**
 * Computes a stable source-file identity without reading the complete file on
 * the browser main thread. The Worker reads only one 1MiB File slice at once.
 */
export function computeFileIdentity(
	file: File,
	options: ComputeFileIdentityOptions = {},
): Promise<SourceFileIdentity> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(
			new URL('./file-identity.worker.ts', import.meta.url),
			{ type: 'module' },
		);
		let settled = false;

		const cleanup = () => {
			worker.terminate();
			options.signal?.removeEventListener('abort', onAbort);
		};
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));

		worker.onmessage = (event: MessageEvent<WorkerResult>) => {
			const result = event.data;
			if ('identity' in result) finish(() => resolve(result.identity));
			else finish(() => reject(new Error(result.message)));
		};
		worker.onerror = () => finish(() => reject(new Error('파일 identity 계산 워커가 중단되었습니다.')));
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener('abort', onAbort, { once: true });
		worker.postMessage({ type: 'compute', file });
	});
}
