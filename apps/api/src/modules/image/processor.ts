import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { ImageRejectedError } from './errors.js';
import { materializeImageSource } from './materialize.js';
import { assertPdfPagePolicy, assertRasterPolicy, type ImageWorkerLimits } from './policy.js';
import type { ImageOperations, ImageRepresentationRole, ImageWorkerRepository, ImageWorkerStorage, VerifyingImageSession } from './ports.js';

const REQUIRED_ROLES = new Set<ImageRepresentationRole>(['ORIGINAL', 'CARD_480', 'DISPLAY_960']);

export interface ImageProcessorDependencies {
	repository: ImageWorkerRepository;
	storage: ImageWorkerStorage;
	operations: ImageOperations;
	tempRoot: string;
	protectedBucket: string;
	publicBucket: string;
	limits: ImageWorkerLimits;
	clock: { now(): Date };
	logger: { info(value: Record<string, unknown>, message: string): void; warn(value: Record<string, unknown>, message: string): void };
}

export function createImageProcessor(deps: ImageProcessorDependencies) {
	return {
		async process(session: VerifyingImageSession, token: string, signal?: AbortSignal,
			assertOwned: () => Promise<void> = async () => undefined): Promise<{ assetId: string }> {
			if (!['IMAGE', 'POSTER'].includes(session.kind) || session.state !== 'VERIFYING') {
				throw new Error('Image processor received an incompatible session');
			}
			if (session.bucket !== deps.protectedBucket) {
				throw new ImageRejectedError('Image source is outside the protected upload bucket', 'MAGIC_INVALID');
			}
			await assertOwned();
			const source = await deps.storage.stream(session.bucket, session.objectKey, signal);
			if (source.size !== Number(session.totalBytes)) {
				throw new ImageRejectedError('Completed source size mismatch', 'SOURCE_IDENTITY_INVALID');
			}
			const workspace = await materializeImageSource({
				session, body: source.body, tempRoot: deps.tempRoot, maxBytes: deps.limits.maxSourceBytes, signal,
			});
			try {
				if (session.declaredMimeType && session.declaredMimeType !== workspace.mimeType) {
					deps.logger.warn({ sessionId: session.id, declaredMimeType: session.declaredMimeType,
						detectedMimeType: workspace.mimeType }, 'Image declared MIME did not match magic bytes');
				}
				if (workspace.mimeType === 'application/pdf') {
					const pdf = await deps.operations.renderPdfFirstPage(workspace.sourcePath, workspace.pdfRasterPath, signal);
					assertPdfPagePolicy(pdf.pages, deps.limits);
					assertRasterPolicy(await deps.operations.inspectRaster(workspace.pdfRasterPath, signal), deps.limits);
				} else {
					assertRasterPolicy(await deps.operations.inspectRaster(workspace.sourcePath, signal), deps.limits);
				}
				await assertOwned();
				const outputs = await deps.operations.createOutputs({
					sourcePath: workspace.sourcePath,
					sourceMimeType: workspace.mimeType,
					...(workspace.mimeType === 'application/pdf' ? { pdfRasterPath: workspace.pdfRasterPath } : {}),
					outputDirectory: workspace.directory,
					signal,
				});
				if (outputs.length !== REQUIRED_ROLES.size
					|| new Set(outputs.map(({ role }) => role)).size !== REQUIRED_ROLES.size
					|| outputs.some(({ role }) => !REQUIRED_ROLES.has(role))) {
					throw new Error('Image operations did not produce the canonical role set');
				}
				let physicalBytes = workspace.sizeBytes;
				if (workspace.mimeType === 'application/pdf') physicalBytes += (await stat(workspace.pdfRasterPath)).size;
				physicalBytes += outputs.reduce((sum, output) => sum + output.sizeBytes, 0);
				if (physicalBytes > deps.limits.maxTempBytes) {
					throw new ImageRejectedError('Image processing exceeded its temp disk budget', 'RESOURCE_LIMIT');
				}
				await assertOwned();
				const plan = await deps.repository.prepareOutputPlan({
					session, token,
					outputs: outputs.map(({ role, extension, mimeType, width, height }) => ({ role, extension, mimeType, width, height })),
					notBefore: new Date(deps.clock.now().getTime() + 2 * 60 * 60_000),
				});
				if (plan.outputs.length !== outputs.length || plan.outputs.some((output) => (
					output.bucket !== deps.publicBucket && output.bucket !== deps.protectedBucket
				) || (output.bucket === deps.protectedBucket
					&& (output.publicationBucket !== deps.publicBucket || !output.publicationObjectKey)))) {
					throw new Error('Repository returned an invalid image output plan');
				}
				for (const output of outputs) {
					const target = plan.outputs.find(({ role }) => role === output.role);
					if (!target) throw new Error(`Output plan omitted ${output.role}`);
					await assertOwned();
					const existing = await deps.storage.head(target.bucket, target.objectKey, signal);
					if (existing?.size !== output.sizeBytes || existing.checksumSha256 !== output.checksumSha256) {
						await assertOwned();
						await deps.storage.upload({
							bucket: target.bucket, key: target.objectKey, body: createReadStream(output.path),
							contentType: output.mimeType, contentLength: output.sizeBytes,
							checksumSha256: output.checksumSha256, signal,
						});
					}
					await assertOwned();
					await deps.repository.markOutputUploaded({ session, token, intentId: target.intentId });
				}
				await assertOwned();
				await deps.repository.commitReady({
					session, token, assetId: plan.assetId,
					sourceCleanup: { bucket: session.bucket, objectKey: session.objectKey },
					outputs: outputs.map((output) => {
						const target = plan.outputs.find(({ role }) => role === output.role);
						if (!target) throw new Error(`Output plan omitted ${output.role}`);
						const { path: _path, extension: _extension, ...metadata } = output;
						return {
							...metadata, bucket: target.bucket, objectKey: target.objectKey, intentId: target.intentId,
							...(target.publicationBucket ? { publicationBucket: target.publicationBucket } : {}),
							...(target.publicationObjectKey ? { publicationObjectKey: target.publicationObjectKey } : {}),
						};
					}),
				});
				deps.logger.info({ sessionId: session.id, assetId: plan.assetId, sourceMimeType: workspace.mimeType },
					'Image worker committed canonical ready representations');
				return { assetId: plan.assetId };
			} finally {
				await workspace.cleanup();
			}
		},
	};
}

export type ImageProcessor = ReturnType<typeof createImageProcessor>;
