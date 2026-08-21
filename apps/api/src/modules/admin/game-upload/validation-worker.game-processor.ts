import { mkdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { validateBoundedZipFile, type BoundedZipValidationOptions } from '../../archive/bounded-zip-validator.js';
import { materializeAndValidateCompletedSource } from './source-identity.js';

/**
 * Worker-only GAME validation boundary. It accepts an already authorized
 * Garage object stream; no Fastify dependency, response stream, or storage
 * mutation is available here. The caller owns leasing/state transitions.
 */
export async function materializeAndValidateGameSource(input: {
	session: {
		id: string;
		totalBytes: bigint;
		sourceIdentityAlgorithm?: string | null;
		sourceIdentity?: string | null;
		sourceIdentityBlockSizeBytes?: number | null;
		sourceIdentityBlockManifest?: Uint8Array | null;
	};
	source: Readable;
	tempRoot: string;
	physicalByteLimit: number;
	signal?: AbortSignal;
	onBytes?(bytes: number): void;
	zipPolicy?: Omit<BoundedZipValidationOptions, 'profile' | 'signal'>;
}): Promise<Awaited<ReturnType<typeof validateBoundedZipFile>>> {
	const root = resolve(input.tempRoot);
	const safeSessionId = Buffer.from(input.session.id, 'utf8').toString('base64url');
	const directory = join(root, `game-upload-${safeSessionId}`);
	const archivePath = join(directory, 'source.zip');
	await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		await materializeAndValidateCompletedSource({
			...input.session,
			source: input.source,
			destination: createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
			physicalByteLimit: input.physicalByteLimit,
			signal: input.signal,
			onBytes: input.onBytes,
		});
		return await validateBoundedZipFile(archivePath, {
			profile: 'GAME',
			signal: input.signal,
			maxArchiveBytes: input.physicalByteLimit,
			...input.zipPolicy,
		});
	} finally {
		// A retry uses a new worker temp directory; source durability remains in Garage.
		await rm(directory, { recursive: true, force: true });
	}
}
