import type { FastifyInstance } from 'fastify';
import { sendOk } from '../../../shared/http.js';
import { badRequest, payloadTooLarge } from '../../../shared/errors.js';
import { requireRole } from '../../../plugins/auth.js';
import * as importService from './service.js';

const MAX_JSON_SIZE = 10 * 1024 * 1024; // 10 MB

/** Extract JSON string from multipart file upload */
async function extractJsonFromMultipart(request: { file: () => Promise<unknown> }): Promise<string> {
	const file = await (request as any).file();
	if (!file) throw badRequest('JSON 파일이 필요합니다.');

	const mimeType: string = file.mimetype ?? '';
	const fileName: string = file.filename ?? '';
	if (!fileName.endsWith('.json') && !mimeType.includes('json')) {
		throw badRequest('JSON 파일만 업로드할 수 있습니다.');
	}

	// Stream to buffer with size check
	const chunks: Buffer[] = [];
	let totalSize = 0;
	for await (const chunk of file.file) {
		totalSize += chunk.length;
		if (totalSize > MAX_JSON_SIZE) {
			throw payloadTooLarge(`파일 크기가 ${MAX_JSON_SIZE / 1024 / 1024}MB를 초과합니다.`);
		}
		chunks.push(chunk);
	}

	return Buffer.concat(chunks).toString('utf-8');
}

/** Register import routes under /api/admin/ */
export async function importController(app: FastifyInstance): Promise<void> {
	/** POST /import/preview — validate JSON and return preview info */
	app.post(
		'/import/preview',
		{ preHandler: requireRole('ADMIN') },
		async (request, reply) => {
			const raw = await extractJsonFromMultipart(request);
			const preview = await importService.previewImport(raw);
			sendOk(reply, preview);
		},
	);

	/** POST /import/execute — actually import the data (all-or-nothing) */
	app.post(
		'/import/execute',
		{ preHandler: requireRole('ADMIN') },
		async (request, reply) => {
			const raw = await extractJsonFromMultipart(request);
			const result = await importService.executeImport(raw, request.currentUser!.id);
			sendOk(reply, result);
		},
	);
}
