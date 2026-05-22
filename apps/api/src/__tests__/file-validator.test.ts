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

interface ZipEntrySpec {
	name: string;
	flags?: number;
	compressionMethod?: number;
	compressedSize?: number;
	uncompressedSize?: number;
}

function makeZip(entries: ZipEntrySpec[]): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name);
		const flags = entry.flags ?? 0;
		const method = entry.compressionMethod ?? 0;
		const compressedSize = entry.compressedSize ?? 0;
		const uncompressedSize = entry.uncompressedSize ?? compressedSize;
		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(compressedSize, 18);
		local.writeUInt32LE(uncompressedSize, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);
		localParts.push(local, Buffer.alloc(compressedSize));

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(compressedSize, 20);
		central.writeUInt32LE(uncompressedSize, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		centralParts.push(central);

		offset += local.length + compressedSize;
	}

	const centralDirectory = Buffer.concat(centralParts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDirectory.length, 12);
	eocd.writeUInt32LE(offset, 16);

	return Buffer.concat([...localParts, centralDirectory, eocd]);
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

	it('rejects a ZIP disguised as an IMAGE upload', async () => {
		const tmpPath = await makeTempFile('image.jpg', makeZip([{ name: 'game/index.html' }]));

		await expect(validateFile(tmpPath, 'IMAGE')).rejects.toMatchObject({
			statusCode: 400,
			message: 'Images must be JPEG, PNG, WebP, or PDF',
		} satisfies Partial<AppError>);
	});

	it('rejects a JPEG disguised as a GAME upload', async () => {
		const tmpPath = await makeTempFile('game.zip', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

		await expect(validateFile(tmpPath, 'GAME')).rejects.toMatchObject({
			statusCode: 400,
			message: 'Game file must be a ZIP archive',
		} satisfies Partial<AppError>);
	});

	it('accepts a structurally valid GAME ZIP', async () => {
		const tmpPath = await makeTempFile('game.zip', makeZip([{ name: 'build/index.html' }]));

		await expect(validateFile(tmpPath, 'GAME')).resolves.toMatchObject({
			mimeType: 'application/zip',
			ext: 'zip',
		});
	});

	it('rejects ZIP path traversal entries', async () => {
		const tmpPath = await makeTempFile('game.zip', makeZip([{ name: '../evil.txt' }]));

		await expect(validateFile(tmpPath, 'GAME')).rejects.toMatchObject({
			statusCode: 400,
			message: 'ZIP archive contains an unsafe file path',
		} satisfies Partial<AppError>);
	});

	it('rejects encrypted ZIP entries', async () => {
		const tmpPath = await makeTempFile('game.zip', makeZip([{ name: 'game.dat', flags: 0x1 }]));

		await expect(validateFile(tmpPath, 'GAME')).rejects.toMatchObject({
			statusCode: 400,
			message: 'Encrypted ZIP archives are not allowed',
		} satisfies Partial<AppError>);
	});

	it('rejects high-ratio ZIP bomb candidates', async () => {
		const tmpPath = await makeTempFile(
			'game.zip',
			makeZip([{ name: 'huge.bin', compressedSize: 1, uncompressedSize: 102 }]),
		);

		await expect(validateFile(tmpPath, 'GAME')).rejects.toMatchObject({
			statusCode: 400,
			message: 'ZIP archive compression ratio is too high',
		} satisfies Partial<AppError>);
	});

	it('rejects nested archives inside GAME ZIP files', async () => {
		const tmpPath = await makeTempFile('game.zip', makeZip([{ name: 'payload/inner.zip' }]));

		await expect(validateFile(tmpPath, 'GAME')).rejects.toMatchObject({
			statusCode: 400,
			message: 'Nested archives are not allowed in game ZIP files',
		} satisfies Partial<AppError>);
	});
});
