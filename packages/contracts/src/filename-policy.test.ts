import { describe, expect, it } from 'vitest';
import {
	attachmentContentDisposition,
	buildGameDownloadFilename,
	GAME_DOWNLOAD_FALLBACK_FILENAME,
	sanitizeFilenameComponent,
	utf8ByteLength,
	validateUploadFilename,
} from './filename-policy.js';

describe('filename policy', () => {
	it('counts UTF-8 bytes for ASCII, Korean, and supplementary characters', () => {
		expect(utf8ByteLength('abc')).toBe(3);
		expect(utf8ByteLength('홍길동')).toBe(9);
		expect(utf8ByteLength('🎮')).toBe(4);
	});

	it('accepts a portable upload filename at the 255-byte boundary', () => {
		const filename = `${'a'.repeat(251)}.zip`;
		expect(utf8ByteLength(filename)).toBe(255);
		expect(validateUploadFilename(filename)).toEqual([]);
	});

	it('returns every reason for an invalid upload filename', () => {
		const filename = `${'a'.repeat(256)}/CON?.zip.\n`;
		const codes = validateUploadFilename(filename).map((reason) => reason.code);
		expect(codes).toEqual(expect.arrayContaining([
			'too_long',
			'path_separator',
			'forbidden_character',
			'control_character',
		]));
	});

	it.each(['CON.txt', 'lpt9.zip', '..', 'name.zip.', 'safe\u202efile.zip'])(
		'rejects non-portable upload filename %s',
		(filename) => expect(validateUploadFilename(filename)).not.toEqual([]),
	);

	it('sanitizes unsafe download components', () => {
		expect(sanitizeFilenameComponent('  My/Game?:\u202e  ')).toBe('My_Game___');
		expect(sanitizeFilenameComponent('CON')).toBe('_CON');
	});

	it('builds the game filename in stable member order', () => {
		const result = buildGameDownloadFilename('별빛 게임', [
			{ id: 2, name: '김철수', studentId: '2026002', sortOrder: 1 },
			{ id: 3, name: '이영희', studentId: '2026003', sortOrder: 0 },
			{ id: 1, name: '홍길동', studentId: '2026001', sortOrder: 1 },
		]);

		expect(result).toEqual({
			filename: '별빛 게임_이영희_2026003_홍길동_2026001_김철수_2026002.zip',
			usedFallback: false,
		});
	});

	it('falls back to game.zip above 255 UTF-8 bytes', () => {
		const result = buildGameDownloadFilename('가'.repeat(84), [
			{ id: 1, name: '홍길동', studentId: '2026001', sortOrder: 0 },
		]);
		expect(result).toEqual({ filename: GAME_DOWNLOAD_FALLBACK_FILENAME, usedFallback: true });
	});

	it('encodes a safe RFC 5987 attachment disposition', () => {
		expect(attachmentContentDisposition('별빛 게임_홍길동_2026001.zip')).toBe(
			'attachment; filename="game.zip"; filename*=UTF-8\'\'%EB%B3%84%EB%B9%9B%20%EA%B2%8C%EC%9E%84_%ED%99%8D%EA%B8%B8%EB%8F%99_2026001.zip',
		);
		expect(attachmentContentDisposition('bad\r\nname.zip')).not.toMatch(/[\r\n]/u);
	});
});
