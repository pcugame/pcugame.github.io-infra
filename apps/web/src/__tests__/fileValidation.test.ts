import { describe, expect, it } from 'vitest';

import type { ClientUploadLimits } from '../lib/upload-limits';
import {
	findOversizedAssetFile,
	formatFileSizeMb,
	getAssetLimitMb,
	isPdfFile,
} from '../lib/upload/fileValidation';

const limits: ClientUploadLimits = {
	imageMaxMb: 10,
	imagePdfMaxMb: 100,
	posterMaxMb: 15,
	posterPdfMaxMb: 50,
	gameMaxMb: 5120,
	videoMaxMb: 1024,
	requestMaxMb: 1200,
	maxFiles: 20,
};

function file(name: string, sizeMb: number, type = 'application/octet-stream') {
	return new File([new Uint8Array(sizeMb * 1024 * 1024)], name, { type });
}

describe('fileValidation', () => {
	it('detects pdf files by mime type or extension', () => {
		expect(isPdfFile(file('poster.bin', 1, 'application/pdf'))).toBe(true);
		expect(isPdfFile(file('poster.PDF', 1))).toBe(true);
		expect(isPdfFile(file('poster.png', 1, 'image/png'))).toBe(false);
	});

	it('uses pdf-specific image and poster limits', () => {
		expect(getAssetLimitMb('POSTER', file('poster.png', 1, 'image/png'), limits)).toBe(15);
		expect(getAssetLimitMb('POSTER', file('poster.pdf', 1), limits)).toBe(50);
		expect(getAssetLimitMb('IMAGE', file('image.pdf', 1), limits)).toBe(100);
		expect(getAssetLimitMb('VIDEO', file('demo.mp4', 1, 'video/mp4'), limits)).toBe(1024);
	});

	it('finds the first oversized file for an asset kind', () => {
		const ok = file('ok.png', 10, 'image/png');
		const oversized = file('large.png', 11, 'image/png');

		expect(findOversizedAssetFile('IMAGE', [ok, oversized], limits)).toBe(oversized);
		expect(findOversizedAssetFile('IMAGE', [ok], limits)).toBeUndefined();
	});

	it('formats bytes as one decimal megabytes', () => {
		expect(formatFileSizeMb(1536 * 1024)).toBe('1.5');
	});
});
