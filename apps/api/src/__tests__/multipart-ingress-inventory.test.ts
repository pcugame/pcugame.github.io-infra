import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const MULTIPART_CONSUMER = /request\.(?:parts|file|files|saveRequestFiles)\s*\(/;

describe('client multipart ingress inventory', () => {
	it('keeps every Fastify multipart consumer explicit and encoded-byte limited', async () => {
		const modulesRoot = new URL('../modules/', import.meta.url);
		const entries = await readdir(modulesRoot, { recursive: true });
		const consumers: string[] = [];
		for (const entry of entries) {
			if (!entry.endsWith('.ts')) continue;
			const source = await readFile(new URL(entry, modulesRoot), 'utf8');
			if (!MULTIPART_CONSUMER.test(source)) continue;
			consumers.push(entry);
			expect(source, entry).toContain('limitEncodedMultipartBody');
		}

		expect(consumers.sort()).toEqual([
			'admin/import/controller.ts',
			'admin/project/multipart.controller.ts',
			'admin/year/controller.ts',
		]);
	});
});
