import { describe, expect, it, vi } from 'vitest';
import { validateProjectUploadFile } from '../modules/admin/project/project-file-validation.js';

describe('project inline file validation boundary', () => {
	it('routes WEBGL to the direct multipart session without opening local bytes', async () => {
		const fileSystem = {
			stat: vi.fn(),
			readRange: vi.fn(),
		};

		await expect(validateProjectUploadFile(
			fileSystem as never,
			'/tmp/must-not-open.zip',
			'WEBGL',
		)).rejects.toMatchObject({
			statusCode: 400,
			message: 'WebGL uses the direct multipart upload session',
		});
		expect(fileSystem.stat).not.toHaveBeenCalled();
		expect(fileSystem.readRange).not.toHaveBeenCalled();
	});
});
