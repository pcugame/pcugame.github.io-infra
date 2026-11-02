import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateBoundedZipFile } from '../../apps/api/src/modules/archive/bounded-zip-validator.ts';
import { inspectBuildPackage, isBuildContainer } from '../../apps/api/src/modules/build-package/inspect.ts';
const catalog = JSON.parse(await readFile('scripts/build-fixtures/native.json', 'utf8'));
for (const name of process.argv.slice(2)) {
	const archivePath = join(process.env.NATIVE_FIXTURE_ROOT ?? '/tmp/pcu-build-native', name + '.zip');
	const summary = await validateBoundedZipFile(archivePath, {
		profile: 'GAME',
		allowNestedArchivePath: isBuildContainer,
	});
	const result = await inspectBuildPackage({ archivePath, summary, tempByteLimit: 6 * 1024 ** 3 });
	console.log(JSON.stringify({ name, ...result, files: result.files.length }));
	const expected = ['godot-generated-external', 'godot-generated-embedded'].includes(name)
		? 'PASS'
		: catalog.find((r: { name: string }) => r.name === name)?.expected;
	if (result.outcome !== expected) process.exitCode = 1;
}
