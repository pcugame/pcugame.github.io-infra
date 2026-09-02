import { describe, expect, it } from 'vitest';
import {
	detectFileType,
	isAllowedGameType,
	isAllowedImageType,
	isAllowedPosterType,
	isAllowedVideoType,
	SIZE_LIMITS,
} from '../shared/file-signature.js';

const imageSamples = [
	['JPEG', Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==', 'base64'), { mime: 'image/jpeg', ext: 'jpg' }],
	['PNG', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), { mime: 'image/png', ext: 'png' }],
	['WebP', Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'), { mime: 'image/webp', ext: 'webp' }],
] as const;

function isoBaseMediaSample(brand: string): Buffer {
	const sample = Buffer.alloc(24);
	sample.writeUInt32BE(24, 0);
	sample.write('ftyp', 4, 'ascii');
	sample.write(brand, 8, 'ascii');
	sample.write(brand, 16, 'ascii');
	return sample;
}

function ebmlSample(documentType: 'webm' | 'matroska'): Buffer {
	return Buffer.from([
		0x1a, 0x45, 0xdf, 0xa3,
		0x80 + 3 + documentType.length,
		0x42, 0x82, 0x80 + documentType.length,
		...Buffer.from(documentType),
	]);
}

function asfSample(stream: 'video' | 'audio'): Buffer {
	const header = Buffer.alloc(30);
	Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex').copy(header);
	header.writeBigUInt64LE(70n, 16);
	header.writeUInt32LE(1, 24);
	const streamProperties = Buffer.alloc(24);
	Buffer.from('9107dcb7b7a9cf118ee600c00c205365', 'hex').copy(streamProperties);
	streamProperties.writeBigUInt64LE(40n, 16);
	const streamType = stream === 'video'
		? Buffer.from('c0ef19bc4d5bcf11a8fd00805f5c442b', 'hex')
		: Buffer.from('409e69f84d5bcf11a8fd00805f5c442b', 'hex');
	return Buffer.concat([header, streamProperties, streamType]);
}

describe('detectFileType', () => {
	it.each(imageSamples)('detects a real %s sample', async (_name, sample, expected) => {
		await expect(detectFileType(sample)).resolves.toEqual(expected);
	});

	it('detects a valid empty ZIP archive', async () => {
		const sample = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');
		await expect(detectFileType(sample)).resolves.toEqual({ mime: 'application/zip', ext: 'zip' });
	});

	it('detects a minimal PDF document', async () => {
		const sample = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
		await expect(detectFileType(sample)).resolves.toEqual({ mime: 'application/pdf', ext: 'pdf' });
	});

	it.each([
		['MP4', isoBaseMediaSample('isom'), { mime: 'video/mp4', ext: 'mp4' }],
		['MOV', isoBaseMediaSample('qt  '), { mime: 'video/mp4', ext: 'mov' }],
		['M4V', isoBaseMediaSample('M4V '), { mime: 'video/mp4', ext: 'm4v' }],
		['3GP', isoBaseMediaSample('3gp5'), { mime: 'video/mp4', ext: '3gp' }],
		['3G2', isoBaseMediaSample('3g2a'), { mime: 'video/mp4', ext: '3g2' }],
		['WebM', ebmlSample('webm'), { mime: 'video/x-matroska', ext: 'webm' }],
		['Matroska', ebmlSample('matroska'), { mime: 'video/x-matroska', ext: 'mkv' }],
	] as const)('normalizes a real %s container sample', async (_name, sample, expected) => {
		await expect(detectFileType(sample)).resolves.toEqual(expected);
	});

	it('normalizes a real AVI container sample', async () => {
		const sample = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI '), Buffer.alloc(20)]);
		await expect(detectFileType(sample)).resolves.toEqual({ mime: 'video/x-msvideo', ext: 'avi' });
	});

	it('normalizes only video ASF as WMV', async () => {
		await expect(detectFileType(asfSample('video'))).resolves.toEqual({ mime: 'video/x-ms-wmv', ext: 'wmv' });
		await expect(detectFileType(asfSample('audio'))).resolves.toBeNull();
		const generic = Buffer.concat([
			Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex'),
			Buffer.alloc(16),
		]);
		await expect(detectFileType(generic)).resolves.toBeNull();
	});

	it('rejects false RIFF markers and supported-but-disallowed audio', async () => {
		const falseRiff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('NOPE'), Buffer.alloc(20)]);
		const wave = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(20)]);
		await expect(detectFileType(falseRiff)).resolves.toBeNull();
		await expect(detectFileType(wave)).resolves.toBeNull();
	});

	it('returns null for short and unknown input', async () => {
		await expect(detectFileType(Buffer.from([0x52, 0x49, 0x46, 0x46]))).resolves.toBeNull();
		await expect(detectFileType(Buffer.alloc(32))).resolves.toBeNull();
	});
});

describe('allowed file types', () => {
	it('allows the canonical image and poster types', () => {
		for (const result of [
			{ mime: 'image/jpeg', ext: 'jpg' },
			{ mime: 'image/png', ext: 'png' },
			{ mime: 'image/webp', ext: 'webp' },
			{ mime: 'application/pdf', ext: 'pdf' },
		]) {
			expect(isAllowedImageType(result)).toBe(true);
			expect(isAllowedPosterType(result)).toBe(true);
		}
		expect(isAllowedImageType({ mime: 'application/zip', ext: 'zip' })).toBe(false);
		expect(isAllowedPosterType({ mime: 'video/mp4', ext: 'mp4' })).toBe(false);
	});

	it('allows only ZIP for games', () => {
		expect(isAllowedGameType({ mime: 'application/zip', ext: 'zip' })).toBe(true);
		expect(isAllowedGameType({ mime: 'image/jpeg', ext: 'jpg' })).toBe(false);
	});

	it('allows all canonical video MIME types', () => {
		for (const mime of ['video/mp4', 'video/x-matroska', 'video/x-msvideo', 'video/x-ms-wmv']) {
			expect(isAllowedVideoType({ mime, ext: 'fixture' })).toBe(true);
		}
		expect(isAllowedVideoType({ mime: 'audio/x-ms-asf', ext: 'asf' })).toBe(false);
	});
});

describe('SIZE_LIMITS', () => {
	it('keeps larger PDF ceilings for image sources', () => {
		expect(SIZE_LIMITS.posterPdf).toBeGreaterThan(SIZE_LIMITS.poster);
		expect(SIZE_LIMITS.imagePdf).toBe(100 * 1024 * 1024);
		expect(SIZE_LIMITS.imagePdf).toBeGreaterThan(SIZE_LIMITS.image);
	});
});
