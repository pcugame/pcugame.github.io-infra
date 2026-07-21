import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createExportFileWriter } from '../modules/admin/export/file.adapter.js';

const directories: string[] = [];

async function makeWriter(body: Readable) {
	const directory = await fs.mkdtemp(join(tmpdir(), 'pcu-export-writer-'));
	directories.push(directory);
	const destination = join(directory, 'asset.bin');
	const writer = createExportFileWriter({
		ids: { next: () => 'test-id' },
		getObject: async () => body,
		createWriteStream,
		rename: fs.rename,
		remove: fs.unlink,
		logCleanupError: () => {},
	});
	return { writer, destination, temporaryPath: `${destination}.test-id.tmp` };
}

describe('export file adapter', () => {
	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => (
			fs.rm(directory, { recursive: true, force: true })
		)));
	});

	it('publishes a complete file with a sibling atomic rename', async () => {
		const { writer, destination, temporaryPath } = await makeWriter(Readable.from(['complete']));

		await writer.saveObject('public', 'asset.bin', destination);

		await expect(fs.readFile(destination, 'utf8')).resolves.toBe('complete');
		await expect(fs.access(temporaryPath)).rejects.toThrow();
	});

	it('removes the temporary file when streaming fails', async () => {
		const body = Readable.from((async function* failingBody() {
			yield Buffer.from('partial');
			throw new Error('stream interrupted');
		})());
		const { writer, destination, temporaryPath } = await makeWriter(body);

		await expect(writer.saveObject('public', 'asset.bin', destination))
			.rejects.toThrow('stream interrupted');
		await expect(fs.access(destination)).rejects.toThrow();
		await expect(fs.access(temporaryPath)).rejects.toThrow();
	});
});
