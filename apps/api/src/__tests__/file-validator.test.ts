import { afterEach, describe, expect, it } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateFile } from '../modules/assets/upload/file-validator.js';
import { AppError } from '../shared/errors.js';
import { SIZE_LIMITS } from '../shared/file-signature.js';

const tempDirs: string[] = [];

async function makeTempFile(name: string, header: Buffer, sizeBytes?: number): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pcu-upload-test-'));
	tempDirs.push(dir);
	const filePath = path.join(dir, name);
	await fsp.writeFile(filePath, header);
	if (sizeBytes !== undefined) {
		await fsp.truncate(filePath, sizeBytes);
	}
	return filePath;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('validateFile', () => {
	it('allows source PDFs for IMAGE uploads up to the IMAGE PDF ceiling', async () => {
		const tmpPath = await makeTempFile(
			'image-source.pdf',
			Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
			SIZE_LIMITS.image + 1,
		);

		await expect(validateFile(tmpPath, 'IMAGE')).resolves.toMatchObject({
			mimeType: 'application/pdf',
			ext: 'pdf',
			sizeBytes: SIZE_LIMITS.image + 1,
		});
	});

	it('rejects IMAGE PDFs above the 100MB source ceiling', async () => {
		const tmpPath = await makeTempFile(
			'too-large-image-source.pdf',
			Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
			SIZE_LIMITS.imagePdf + 1,
		);

		await expect(validateFile(tmpPath, 'IMAGE')).rejects.toMatchObject({
			statusCode: 400,
			message: 'File too large for kind IMAGE',
		} satisfies Partial<AppError>);
	});

	it('keeps the normal IMAGE ceiling for JPEG uploads', async () => {
		const tmpPath = await makeTempFile(
			'too-large-image.jpg',
			Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
			SIZE_LIMITS.image + 1,
		);

		await expect(validateFile(tmpPath, 'IMAGE')).rejects.toMatchObject({
			statusCode: 400,
			message: 'File too large for kind IMAGE',
		} satisfies Partial<AppError>);
	});
});
