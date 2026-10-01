import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { analyzeWebglDisplayArchive } from './display-analysis.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const html = await readFile(new URL('./fixtures/unity-default.html', import.meta.url), 'utf8');
const css = await readFile(new URL('./fixtures/unity-default.css', import.meta.url), 'utf8');

// These tests isolate the reader after safety validation, using a small stored ZIP.
// ZIP CRC validation and source identity remain covered by the processor suite.
function zipBytes(files: Array<[string, string]>): Buffer {
	const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
	for (const [path, text] of files) {
		const name = Buffer.from(path); const body = Buffer.from(text);
		const local = Buffer.alloc(30 + name.length + body.length);
		local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
		local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
		name.copy(local, 30); body.copy(local, 30 + name.length); locals.push(local);
		const entry = Buffer.alloc(46 + name.length);
		entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
		entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(body.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
		name.copy(entry, 46); central.push(entry); offset += local.length;
	}
	const directory = Buffer.concat(central); const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
async function analyze(files: Array<[string, string]>, wrapper = '', allowed?: string[]) {
	files = [...files, ...['Build/Build.loader.js', 'Build/Build.data', 'Build/Build.framework.js', 'Build/Build.wasm'].map((path): [string, string] => [path, ''])];
	const directory = await mkdtemp(join(tmpdir(), 'pcu-display-test-')); directories.push(directory);
	const archivePath = join(directory, 'test.zip'); await writeFile(archivePath, zipBytes(files.map(([path, content]) => [wrapper + path, content])));
	return analyzeWebglDisplayArchive({ archivePath, layout: { wrapperPrefix: wrapper, files: new Map((allowed ?? files.map(([path]) => path)).map((path) => [wrapper + path, path])) } });
}
it.each(['', 'UnityBuild/'])('reads the validated default profile with wrapper %s', async (wrapper) => {
	expect(await analyze([['index.html', html], ['TemplateData/style.css', css]], wrapper)).toEqual({ version: 1, kind: 'fixed', width: 960, height: 642, reason: 'unity-default-desktop' });
});
it('never reads an archive entry omitted by the validated layout', async () => {
	expect((await analyze([['index.html', html], ['TemplateData/style.css', css]], '', ['index.html'])).reason).toBe('missing-local-reference');
});
it('caps a referenced text file before opening its stream', async () => {
	expect((await analyze([['index.html', html], ['TemplateData/style.css', ' '.repeat(256 * 1024 + 1)]])).reason).toBe('text-budget-exceeded');
});
it('caps an oversized index', async () => {
	expect((await analyze([['index.html', ' '.repeat(256 * 1024 + 1)]])).reason).toBe('text-budget-exceeded');
});
it('caps nine unique referenced text files', async () => {
	const links = Array.from({ length: 8 }, (_, i) => `<link rel="stylesheet" href="s${i}.css">`).join('');
	const index = html.replace('<link rel="stylesheet" href="TemplateData/style.css">', links);
	expect((await analyze([['index.html', index], ...Array.from({ length: 8 }, (_, i): [string, string] => [`s${i}.css`, ''])])).reason).toBe('text-budget-exceeded');
});
it('caps aggregate text at one MiB independently of the per-file cap', async () => {
	const links = Array.from({ length: 5 }, (_, i) => `<link rel="stylesheet" href="s${i}.css">`).join('');
	const index = html.replace('<link rel="stylesheet" href="TemplateData/style.css">', links);
	expect((await analyze([['index.html', index], ...Array.from({ length: 5 }, (_, i): [string, string] => [`s${i}.css`, ' '.repeat(230 * 1024)])])).reason).toBe('text-budget-exceeded');
});
it('does not fetch a remote or parent reference even when matching bytes exist in the ZIP', async () => {
	for (const reference of ['../style.css', 'https://example.com/style.css']) {
		expect((await analyze([['index.html', html.replace('TemplateData/style.css', reference)], ['TemplateData/style.css', css]])).reason).toBe('non-local-reference');
	}
});
