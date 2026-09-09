/** Isolated migration child. Parent enforces a hard 180-second process timeout. */
import { readFile, writeFile } from 'node:fs/promises';
import { createImageOperations } from '../src/modules/image/operations.js';
import { createBoundedImageCommandRunner } from '../src/modules/image/command-runner.js';
import { DEFAULT_IMAGE_WORKER_LIMITS } from '../src/modules/image/policy.js';
import { POSTER_CORRECTION_LIMITS } from '../src/modules/migration/canonical-correction.js';

async function main(): Promise<void> {
	const [inputFile, outputFile] = process.argv.slice(2);
	if (!inputFile || !outputFile) throw new Error('Missing private child input/output paths');
	const input = JSON.parse(await readFile(inputFile, 'utf8')) as {
		sourcePath: string; sourceMimeType: 'image/webp' | 'image/jpeg' | 'image/png'; outputDirectory: string;
	};
	// Native libvips allocations are outside the JS heap. Require an actual cgroup
	// memory boundary rather than treating --max-old-space-size as a memory limit.
	let memoryLimit: string;
	try { memoryLimit = await readFile('/sys/fs/cgroup/memory.max', 'utf8'); }
	catch { memoryLimit = await readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8'); }
	if (!/^[0-9]+\s*$/.test(memoryLimit) || BigInt(memoryLimit.trim()) > BigInt(POSTER_CORRECTION_LIMITS.containerMemoryBytes)) {
		throw new Error('Poster correction requires a container memory limit of at most 2 GiB');
	}
	const operations = createImageOperations(createBoundedImageCommandRunner(), {
		...DEFAULT_IMAGE_WORKER_LIMITS, maxPixels: POSTER_CORRECTION_LIMITS.maxPixels,
		maxDecodedBytes: POSTER_CORRECTION_LIMITS.maxDecodedBytes,
	});
	const info = await operations.inspectRaster(input.sourcePath);
	const outputs = await operations.createOutputs(input);
	for (const output of outputs) {
		const verified = await operations.inspectRaster(output.path);
		if (verified.width !== output.width || verified.height !== output.height) throw new Error('Poster output dimensions changed');
		if (output.role !== 'ORIGINAL' && Math.abs(output.height - info.height * output.width / info.width) > 1) throw new Error('Poster output aspect ratio mismatch');
	}
	await writeFile(outputFile, JSON.stringify(outputs), { mode: 0o600, flag: 'wx' });
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
