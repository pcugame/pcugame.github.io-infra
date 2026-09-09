import type { Readable } from 'node:stream';

async function destroyAndWaitForClose(body: Readable): Promise<void> {
	if (body.closed) return;

	await new Promise<void>((resolve, reject) => {
		let cleanupError: unknown;
		const observeCleanupError = (error: unknown) => {
			cleanupError ??= error;
		};
		const finishCleanup = () => {
			body.off('error', observeCleanupError);
			body.off('close', finishCleanup);
			if (cleanupError === undefined) resolve();
			else reject(cleanupError);
		};

		body.on('error', observeCleanupError);
		body.once('close', finishCleanup);
		try {
			body.destroy();
		} catch (error) {
			cleanupError ??= error;
			// A conforming Readable emits close after destroy. If a broken adapter
			// closes synchronously without emitting it, settle from its closed state.
			if (body.closed) finishCleanup();
		}
	});
}

/**
 * Settle a request-owned upload body after ObjectStorage.upload rejects.
 *
 * Storage adapters may reject before consuming a lazily opened fs.ReadStream.
 * The backing temp file must therefore remain in place until destroy has
 * completed and close proves the stream no longer owns it. The caller retains
 * UploadIntent/rollback orchestration and throws the returned failure.
 */
export async function settleUploadStreamFailure(
	body: Readable,
	uploadError: unknown,
	aggregateMessage: string,
): Promise<unknown> {
	try {
		await destroyAndWaitForClose(body);
		return uploadError;
	} catch (cleanupError) {
		return new AggregateError([uploadError, cleanupError], aggregateMessage);
	}
}
