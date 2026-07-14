import { describe, expect, it } from 'vitest';
import { assertValidUploadFilename } from '../shared/filename-validation.js';

describe('upload filename validation', () => {
	it('accepts a portable filename', () => {
		expect(() => assertValidUploadFilename('내 게임.zip')).not.toThrow();
	});

	it('returns a single 400 error containing every violation reason', () => {
		const filename = `${'a'.repeat(256)}/bad?.zip\n`;
		try {
			assertValidUploadFilename(filename);
			throw new Error('expected filename validation to fail');
		} catch (error) {
			expect(error).toMatchObject({
				statusCode: 400,
				code: 'INVALID_FILENAME',
				details: {
					reasons: expect.arrayContaining([
						expect.objectContaining({ code: 'too_long' }),
						expect.objectContaining({ code: 'path_separator' }),
						expect.objectContaining({ code: 'forbidden_character' }),
						expect.objectContaining({ code: 'control_character' }),
					]),
				},
			});
			expect((error as Error).message).toContain('파일명을 사용할 수 없습니다');
		}
	});
});
