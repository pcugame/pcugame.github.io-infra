import { join } from 'node:path';
import { validateBoundedZipFile } from '../../apps/api/src/modules/archive/bounded-zip-validator.ts';
import { inspectBuildPackage, isBuildContainer } from '../../apps/api/src/modules/build-package/inspect.ts';
const root = process.env.ENGINE_FIXTURE_ROOT ?? '/tmp/pcu-build-exports';
for (const engine of process.argv.slice(2)) {
	const archivePath = join(root, `${engine}.zip`);
	const summary = await validateBoundedZipFile(archivePath, {
		profile: 'WEBGL',
		allowNestedArchivePath: isBuildContainer,
	});
	const result = await inspectBuildPackage({
		archivePath,
		summary,
		tempByteLimit: 6 * 1024 ** 3,
	});
	console.log(JSON.stringify({ engine, ...result, files: result.files.length }));
	if (result.outcome !== 'PASS') process.exitCode = 1;
}
