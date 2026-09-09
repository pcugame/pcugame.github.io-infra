import type { Readable } from 'node:stream';

async function destroyAndWaitForClose(body: Readable): Promise<void> {
	if (body.closed) return;
	await new Promise<void>((resolve, reject) => {
		let cleanupError: unknown;
		const observeCleanupError = (error: unknown) => { cleanupError ??= error; };
		const finishCleanup = () => {
			body.off('error', observeCleanupError);
			body.off('close', finishCleanup);
			if (cleanupError === undefined) resolve();
			else reject(cleanupError);
		};
		body.on('error', observeCleanupError);
		body.once('close', finishCleanup);
		try { body.destroy(); }
		catch (error) {
			cleanupError ??= error;
			if (body.closed) finishCleanup();
		}
	});
}

/**
 * Worker/migration-owned storage upload cleanup. It is intentionally not
 * imported by Fastify routes: direct upload bytes never enter the API graph.
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
