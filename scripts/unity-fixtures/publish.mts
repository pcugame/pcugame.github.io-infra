import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { validateBoundedZipFile } from '../../apps/api/src/modules/archive/bounded-zip-validator.ts';
import { analyzeWebglArchive, uploadWebglArchive } from '../../apps/api/src/modules/webgl/archive.ts';
const fixtureRoot = resolve(process.env.FIXTURE_ROOT ?? '/tmp/pcu-unity-fixture-repro');
const records = JSON.parse(await readFile(join(fixtureRoot, 'all-archive-manifest.json'), 'utf8'));
const report = [];
for (const record of records) {
    const zipBytes = await readFile(record.path);
    if (zipBytes.length !== record.size || createHash('sha256').update(zipBytes).digest('hex') !== record.sha256)
        throw Error('archive manifest mismatch');
    const name = record.path.split('/').at(-1).replace('.zip', '');
    const output = join(fixtureRoot, 'published', name);
    await mkdir(output, { recursive: true });
    const summary = await validateBoundedZipFile(record.path, { profile: 'WEBGL' });
    const layout = analyzeWebglArchive(summary);
    const objects = [];
    await uploadWebglArchive({ archivePath: record.path, publicBucket: 'local-fixture', publicPrefix: '', layout, uploader: { async put(input) {
                const path = resolve(output, input.objectKey);
                if (!path.startsWith(output + '/'))
                    throw Error('unsafe output');
                await mkdir(dirname(path), { recursive: true });
                await pipeline(input.body, createWriteStream(path));
                const bytes = await readFile(path);
                const sha256 = createHash('sha256').update(bytes).digest('hex');
                if (sha256 !== input.checksumSha256)
                    throw Error('payload hash mismatch');
                objects.push({ key: input.objectKey, contentType: input.contentType, contentEncoding: input.contentEncoding ?? null, size: bytes.length, sha256 });
            } } });
    await writeFile(join(output, 'hosting-metadata.json'), JSON.stringify(objects, null, 2));
    report.push({ name, zipSHA256: record.sha256, wrapperPrefix: layout.wrapperPrefix, files: objects.length, archiveBytes: summary.archiveBytes, status: 'validated-and-published' });
    console.log(name, objects.length, summary.archiveBytes, 'OK');
}
await writeFile(join(fixtureRoot, 'publisher-results.json'), JSON.stringify(report, null, 2));
