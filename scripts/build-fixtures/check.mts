/** Run after scripts/unity-fixtures/download.py; only parse bytes, never execute games. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validateBoundedZipFile } from '../../apps/api/src/modules/archive/bounded-zip-validator.ts';
import { inspectBuildPackage, isBuildContainer } from '../../apps/api/src/modules/build-package/inspect.ts';
import { analyzeWebglArchive } from '../../apps/api/src/modules/webgl/archive.ts';
const root = process.env.FIXTURE_ROOT ?? '/tmp/pcu-build-acceptance-unity';
const records: Array<{ path: string; size: number; sha256: string }> = JSON.parse(
	await readFile(join(root, 'all-archive-manifest.json'), 'utf8'),
);
for (const record of records) {
	const bytes = await readFile(record.path);
	if (bytes.length !== record.size || createHash('sha256').update(bytes).digest('hex') !== record.sha256)
		throw new Error('Fixture provenance mismatch');
	const summary = await validateBoundedZipFile(record.path, {
		profile: 'WEBGL',
		allowNestedArchivePath: isBuildContainer,
	});
	const result = await inspectBuildPackage({
		archivePath: record.path,
		summary,
		tempByteLimit: 6 * 1024 ** 3,
	});
	if (result.outcome !== 'PASS')
		throw new Error(`${record.path}: ${result.outcome}: ${result.reasons.join(', ')}`);
	const layout = analyzeWebglArchive(summary, result.entryPath!);
	console.log(
		JSON.stringify({
			archive: record.path,
			sha256: record.sha256,
			outcome: result.outcome,
			entryPath: layout.entryPath,
			files: layout.files.size,
		}),
	);
}

if (process.env.GODOT_FIXTURE_ROOT) {
	for (const variant of ['root', 'custom']) {
		const archivePath = join(process.env.GODOT_FIXTURE_ROOT, `godot-pong-${variant}.zip`);
		const summary = await validateBoundedZipFile(archivePath, {
			profile: 'WEBGL',
			allowNestedArchivePath: isBuildContainer,
		});
		const result = await inspectBuildPackage({
			archivePath,
			summary,
			tempByteLimit: 6 * 1024 ** 3,
		});
		if (result.outcome !== 'PASS' || !result.engines.includes('Godot'))
			throw new Error(`${archivePath}: ${result.outcome}: ${result.reasons.join(', ')}`);
		console.log(
			JSON.stringify({
				archive: archivePath,
				outcome: result.outcome,
				entryPath: analyzeWebglArchive(summary, result.entryPath!).entryPath,
			}),
		);
	}
}
