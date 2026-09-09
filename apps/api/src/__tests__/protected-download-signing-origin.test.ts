import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createS3Client } from '../lib/s3.js';
import { createProtectedDownloadPresigner } from '../lib/storage.js';

describe('protected download signing origin', () => {
	it('signs a GET capability against the dedicated browser origin', async () => {
		const client = createS3Client({
			S3_ENDPOINT: 'https://download.example.test',
			S3_REGION: 'garage',
			S3_ACCESS_KEY_ID: 'access-key',
			S3_SECRET_ACCESS_KEY: 'secret-key',
			S3_FORCE_PATH_STYLE: true,
		});
		try {
			const url = new URL(await createProtectedDownloadPresigner(client, {
				defaultPresignTtlSec: 45,
			}).presign('pcu-protected', 'assets/42/original/game.zip'));
			expect(url.origin).toBe('https://download.example.test');
			expect(url.pathname).toBe('/pcu-protected/assets/42/original/game.zip');
			expect(url.searchParams.get('X-Amz-Expires')).toBe('45');
		} finally {
			client.destroy();
		}
	});

	it('wires protected routes to the narrow signer without object-body relay', async () => {
		const source = await readFile(new URL('../modules/assets/composition.ts', import.meta.url), 'utf8');
		expect(source).toContain('ProtectedDownloadPresigner');
		expect(source).toContain('deps.protectedDownloadPresigner.presign');
		expect(source).not.toMatch(/deps\.storage\.(?:stream|readRange|presign)/);
	});
});
