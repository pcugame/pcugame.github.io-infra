import type { ObjectStorage } from '../../application/ports.js';

/** Give storage fixtures the same per-key effects through either deletion API. */
export function batchDeleteStorage(deleteObject: ObjectStorage['delete']): ObjectStorage['deleteKeys'] {
	return async (bucket, keys, request) => {
		const deleted: string[] = [];
		const failures: Array<{ key: string; message: string }> = [];
		for (const key of keys) {
			try {
				await deleteObject(bucket, key, request);
				deleted.push(key);
			} catch (error) {
				failures.push({ key, message: error instanceof Error ? error.message : String(error) });
			}
		}
		return { deleted, failures };
	};
}
