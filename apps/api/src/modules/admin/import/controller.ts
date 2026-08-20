import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ImportExecuteResult, ImportPreviewResult } from '@pcu/contracts';
import { sendOk } from '../../../shared/http.js';
import { badRequest, payloadTooLarge } from '../../../shared/errors.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import {
	limitEncodedMultipartBody,
	rethrowEncodedMultipartError,
} from '../../../shared/encoded-multipart-limit.js';
import { requireRole } from '../../../plugins/auth.js';
import type { createImportService } from './service.js';

const MAX_JSON_SIZE = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_ENCODED_BODY_SIZE = 16 * 1024 * 1024;
const IMPORT_MULTIPART_LIMITS = {
	files: 1,
	fields: 0,
	parts: 1,
	headerPairs: 32,
} as const;

/** Extract JSON string from multipart file upload */
async function extractJsonFromMultipart(
	request: FastifyRequest,
	maxJsonSize: number,
): Promise<string> {
	const parts = request.parts({
		limits: { ...IMPORT_MULTIPART_LIMITS, fileSize: maxJsonSize },
	});
	const first = await parts.next();
	if (first.done) throw badRequest('JSON 파일이 필요합니다.');
	const file = first.value;
	if (file.type !== 'file') {
		throw badRequest('Multipart body must contain exactly one JSON file');
	}
	if (file.fieldname !== 'file') {
		file.file.resume();
		throw badRequest('Multipart field must be file');
	}

	const mimeType: string = file.mimetype ?? '';
	const fileName: string = file.filename ?? '';
	try {
		assertValidUploadFilename(fileName);
	} catch (error) {
		file.file.resume();
		throw error;
	}
	if (!fileName.endsWith('.json') && !mimeType.includes('json')) {
		file.file.resume();
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
	if (file.file.truncated) {
		throw payloadTooLarge(`파일 크기가 ${maxJsonSize / 1024 / 1024}MB를 초과합니다.`);
	}

	// Advance once more so Busboy surfaces fields/files/parts limit errors and
	// so a second or trailing part can never be silently ignored.
	const trailing = await parts.next();
	if (!trailing.done) {
		if (trailing.value.type === 'file') trailing.value.file.resume();
		throw badRequest('Multipart body must contain exactly one JSON file');
	}

	return Buffer.concat(chunks).toString('utf-8');
}

export interface ImportControllerDependencies {
	service: ReturnType<typeof createImportService>;
	maxJsonSize?: number;
	maxEncodedBodySize?: number;
}

/** Register import routes under /api/admin/ from an explicitly composed service. */
export function createImportController(
	deps: ImportControllerDependencies,
): FastifyPluginAsync {
	const maxJsonSize = deps.maxJsonSize ?? MAX_JSON_SIZE;
	const maxEncodedBodySize = deps.maxEncodedBodySize ?? DEFAULT_MAX_ENCODED_BODY_SIZE;
	const routeOptions = () => ({
		preHandler: requireRole('ADMIN'),
		preParsing: async (_request: FastifyRequest, _reply: unknown, payload: Parameters<
			typeof limitEncodedMultipartBody
		>[0]) => limitEncodedMultipartBody(payload, maxEncodedBodySize),
		bodyLimit: maxEncodedBodySize,
	});
	return async function importController(app): Promise<void> {
		/** POST /import/preview — validate JSON and return preview info */
		app.post(
			'/import/preview',
			routeOptions(),
			async (request, reply) => {
				let raw: string;
				try {
					raw = await extractJsonFromMultipart(request, maxJsonSize);
				} catch (error) {
					rethrowEncodedMultipartError(request.raw, maxEncodedBodySize, error);
				}
				const preview = await deps.service.previewImport(raw);
				sendOk<ImportPreviewResult>(reply, preview);
			},
		);

		/** POST /import/execute — actually import the data (all-or-nothing) */
		app.post(
			'/import/execute',
			routeOptions(),
			async (request, reply) => {
				let raw: string;
				try {
					raw = await extractJsonFromMultipart(request, maxJsonSize);
				} catch (error) {
					rethrowEncodedMultipartError(request.raw, maxEncodedBodySize, error);
				}
				const result = await deps.service.executeImport(raw, request.currentUser!.id);
				sendOk<ImportExecuteResult>(reply, result);
			},
		);
	};
}
