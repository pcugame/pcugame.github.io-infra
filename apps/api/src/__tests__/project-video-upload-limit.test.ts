import { describe, expect, it, vi } from 'vitest';
import type { UploadPipelinePort } from '../application/upload-ports.js';
import { processFileParts } from '../modules/admin/project/project-submit.service.js';

describe('Phase-1 multipart video limit', () => {
	it('rejects six videos before running the processing and storage pipeline', async () => {
		const processFile = vi.fn();
		const parts = Array.from({ length: 6 }, (_, index) => ({ fieldname: 'videoFile', filename: `${index}.mp4`, tmpPath: `/tmp/${index}` }));
		await expect(processFileParts(parts, { processFile } as unknown as UploadPipelinePort)).rejects.toMatchObject({ statusCode: 400 });
		expect(processFile).not.toHaveBeenCalled();
	});
});
