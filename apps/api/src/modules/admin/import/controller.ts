import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ImportExecuteResult, ImportPreviewResult } from '@pcu/contracts';
import { sendOk } from '../../../shared/http.js';
import { badRequest, payloadTooLarge } from '../../../shared/errors.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import { requireRole } from '../../../plugins/auth.js';
import type { createImportService } from './service.js';

const MAX_JSON_SIZE = 10 * 1024 * 1024; // 10 MB

/** Extract JSON string from multipart file upload */
async function extractJsonFromMultipart(
	request: FastifyRequest,
	maxJsonSize: number,
): Promise<string> {
	const file = await request.file();
	if (!file) throw badRequest('JSON 파일이 필요합니다.');

	const mimeType: string = file.mimetype ?? '';
	const fileName: string = file.filename ?? '';
	assertValidUploadFilename(fileName);
	if (!fileName.endsWith('.json') && !mimeType.includes('json')) {
		throw badRequest('JSON 파일만 업로드할 수 있습니다.');
	}

	// Stream to buffer with size check
	const chunks: Buffer[] = [];
	let totalSize = 0;
	for await (const chunk of file.file) {
		totalSize += chunk.length;
		if (totalSize > maxJsonSize) {
			throw payloadTooLarge(`파일 크기가 ${maxJsonSize / 1024 / 1024}MB를 초과합니다.`);
		}
		chunks.push(chunk);
	}

	return Buffer.concat(chunks).toString('utf-8');
}

export interface ImportControllerDependencies {
	service: ReturnType<typeof createImportService>;
	maxJsonSize?: number;
}

/** Register import routes under /api/admin/ from an explicitly composed service. */
export function createImportController(
	deps: ImportControllerDependencies,
): FastifyPluginAsync {
	const maxJsonSize = deps.maxJsonSize ?? MAX_JSON_SIZE;
	return async function importController(app): Promise<void> {
		/** POST /import/preview — validate JSON and return preview info */
		app.post(
			'/import/preview',
			{ preHandler: requireRole('ADMIN') },
			async (request, reply) => {
				const raw = await extractJsonFromMultipart(request, maxJsonSize);
				const preview = await deps.service.previewImport(raw);
				sendOk<ImportPreviewResult>(reply, preview);
			},
		);

		/** POST /import/execute — actually import the data (all-or-nothing) */
		app.post(
			'/import/execute',
			{ preHandler: requireRole('ADMIN') },
			async (request, reply) => {
				const raw = await extractJsonFromMultipart(request, maxJsonSize);
				const result = await deps.service.executeImport(raw, request.currentUser!.id);
				sendOk<ImportExecuteResult>(reply, result);
			},
		);
	};
}
