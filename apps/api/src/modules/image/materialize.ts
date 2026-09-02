import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { detectFileTypeFromFile } from '../../shared/file-signature.js';
import { AppError } from '../../shared/errors.js';
import { materializeAndValidateCompletedSource } from '../admin/game-upload/source-identity.js';
import { ImageInfrastructureError, ImageRejectedError } from './errors.js';
import type { VerifyingImageSession } from './ports.js';

function manifest(value: unknown): Uint8Array {
	if (typeof value === 'string') return Buffer.from(value, 'base64');
	if (value instanceof Uint8Array) return value;
	throw new ImageRejectedError('Persisted source identity manifest is malformed', 'SOURCE_IDENTITY_INVALID');
}

function deterministicSourceFailure(error: unknown): boolean {
	if (error instanceof AppError) {
		return error.statusCode === 400 || error.statusCode === 409 || error.code === 'SIZE_MISMATCH';
	}
	return error instanceof Error && (
		error.message === 'Persisted source identity manifest length is invalid'
		|| error.message === 'Invalid worker materialization size budget'
	);
}

export async function materializeImageSource(input: {
	session: VerifyingImageSession;
	body: Readable;
	tempRoot: string;
	maxBytes: number;
	signal?: AbortSignal;
}) {
	const size = Number(input.session.totalBytes);
	if (!Number.isSafeInteger(size) || size < 1 || size > input.maxBytes) {
		throw new ImageRejectedError('Image source size exceeds policy', 'RESOURCE_LIMIT');
	}
	const root = resolve(input.tempRoot);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(root, 'pcu-image-worker-'));
	await chmod(directory, 0o700);
	const sourcePath = join(directory, 'source.bin');
	try {
		await materializeAndValidateCompletedSource({
			totalBytes: input.session.totalBytes,
			sourceIdentityAlgorithm: input.session.sourceIdentityAlgorithm,
			sourceIdentity: input.session.sourceIdentity,
			sourceIdentityBlockSizeBytes: input.session.sourceIdentityBlockSizeBytes,
			sourceIdentityBlockManifest: manifest(input.session.sourceIdentityBlockManifest),
			source: input.body,
			destination: createWriteStream(sourcePath, { flags: 'wx', mode: 0o600 }),
			physicalByteLimit: input.maxBytes,
			signal: input.signal,
		});
		const metadata = await lstat(sourcePath);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new ImageRejectedError('Image workspace source is not a regular file', 'RESOURCE_LIMIT');
		}
		const detected = await detectFileTypeFromFile(sourcePath, { signal: input.signal });
		if (!detected || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(detected.mime)) {
			throw new ImageRejectedError('Source magic is not a supported raster image or PDF', 'MAGIC_INVALID');
		}
		return {
			directory,
			sourcePath,
			pdfRasterPath: join(directory, 'pdf-page-1.png'),
			mimeType: detected.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf',
			sizeBytes: size,
			cleanup: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
		if (input.signal?.aborted) throw input.signal.reason ?? error;
		if (error instanceof ImageRejectedError) throw error;
		if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
			throw new ImageInfrastructureError('Image worker temporary disk is full', { cause: error });
		}
		if (deterministicSourceFailure(error)) {
			throw new ImageRejectedError('Completed object failed source identity validation', 'SOURCE_IDENTITY_INVALID', { cause: error });
		}
		// GET body disconnects, EIO, and destination stream failures are operational
		// faults. They must retain retry semantics instead of blaming the source.
		throw new ImageInfrastructureError('Image source materialization failed transiently', { cause: error });
	}
}
