import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => (
		fs.rm(root, { recursive: true, force: true })
	)));
});

describe('production Node filesystem private directory', () => {
	it('durably creates an empty private recovery record exclusively', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcugame-record-create-'));
		temporaryRoots.push(root);
		const uploadPath = path.join(root, 'pcugame-upload');
		const recordPath = path.join(
			uploadPath, '.legacy-root-recovery-v2.discovery-complete',
		);
		const fileSystem = createNodeFileSystem();
		await fileSystem.ensurePrivateDirectory!(uploadPath);

		await expect(fileSystem.createFileExclusive!(recordPath)).resolves.toBe('created');
		await expect(fs.readFile(recordPath)).resolves.toEqual(Buffer.alloc(0));
		expect((await fs.lstat(recordPath)).mode & 0o777).toBe(0o600);
		expect(await fs.readdir(uploadPath)).toEqual([path.basename(recordPath)]);
	});

	it('reports an exclusive-create collision without replacing its contents', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcugame-record-collision-'));
		temporaryRoots.push(root);
		const uploadPath = path.join(root, 'pcugame-upload');
		const recordPath = path.join(uploadPath, '.legacy-root-recovery-v2.attempt-1');
		const fileSystem = createNodeFileSystem();
		await fileSystem.ensurePrivateDirectory!(uploadPath);
		await fs.writeFile(recordPath, 'pre-existing', { mode: 0o600 });

		await expect(fileSystem.createFileExclusive!(recordPath)).resolves.toBe('exists');
		await expect(fs.readFile(recordPath, 'utf8')).resolves.toBe('pre-existing');
		expect(await fs.readdir(uploadPath)).toEqual([path.basename(recordPath)]);
	});

	it('durably removes a consumed recovery record', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcugame-record-remove-'));
		temporaryRoots.push(root);
		const uploadPath = path.join(root, 'pcugame-upload');
		const recordPath = path.join(uploadPath, '.legacy-root-recovery-v2.attempt-1');
		const fileSystem = createNodeFileSystem();
		await fileSystem.ensurePrivateDirectory!(uploadPath);
		await fileSystem.createFileExclusive!(recordPath);

		await fileSystem.removeFileDurable!(recordPath);
		await expect(fs.access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('identity-bound claim removes the exact no-follow file that was inspected', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcugame-claim-match-'));
		temporaryRoots.push(root);
		const uploadPath = path.join(root, 'pcugame-upload');
		const sourcePath = path.join(
			root,
			'pcu-project-upload-11111111-1111-4111-8111-111111111111',
		);
		const fileSystem = createNodeFileSystem();
		await fileSystem.ensurePrivateDirectory!(uploadPath);
		await fs.writeFile(sourcePath, 'stale');
		const inspected = await fileSystem.lstat!(sourcePath);

		await expect(fileSystem.claimAndRemoveFile!(sourcePath, uploadPath, {
			size: inspected.size,
			lastModifiedMs: inspected.lastModified!.getTime(),
			identity: inspected.identity,
		})).resolves.toBe('removed');
		await expect(fs.access(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await fs.readdir(uploadPath)).toEqual([]);
	});

	it('identity-bound claim never overwrites an existing quarantine basename', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcugame-claim-collision-'));
		temporaryRoots.push(root);
		const uploadPath = path.join(root, 'pcugame-upload');
		const sourcePath = path.join(
			root,
			'pcu-project-upload-11111111-1111-4111-8111-111111111111',
		);
		const ids = [
			'22222222-2222-4222-8222-222222222222',
			'33333333-3333-4333-8333-333333333333',
		];
		const fileSystem = createNodeFileSystem({ uniqueId: () => ids.shift()! });
		await fileSystem.ensurePrivateDirectory!(uploadPath);
		const collisionPath = path.join(uploadPath, `pcu-project-upload-${ids[0]}`);
		await fs.writeFile(collisionPath, 'existing quarantine');
		await fs.writeFile(sourcePath, 'stale');
		const inspected = await fileSystem.lstat!(sourcePath);

		await expect(fileSystem.claimAndRemoveFile!(sourcePath, uploadPath, {
			size: inspected.size,
			lastModifiedMs: inspected.lastModified!.getTime(),
			identity: inspected.identity,
		})).resolves.toBe('removed');
		await expect(fs.readFile(collisionPath, 'utf8')).resolves.toBe('existing quarantine');
		expect(await fs.readdir(uploadPath)).toEqual([path.basename(collisionPath)]);
	});

	it('identity-bound claim restores a replacement whose identity changed', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcugame-claim-changed-'));
		temporaryRoots.push(root);
		const uploadPath = path.join(root, 'pcugame-upload');
		const sourcePath = path.join(
			root,
			'project-asset-22222222-2222-4222-8222-222222222222',
		);
		const fileSystem = createNodeFileSystem();
		await fileSystem.ensurePrivateDirectory!(uploadPath);
		await fs.writeFile(sourcePath, 'stale');
		const inspected = await fileSystem.lstat!(sourcePath);
		await fs.unlink(sourcePath);
		await fs.writeFile(sourcePath, 'fresh replacement');

		await expect(fileSystem.claimAndRemoveFile!(sourcePath, uploadPath, {
			size: inspected.size,
			lastModifiedMs: inspected.lastModified!.getTime(),
			identity: inspected.identity,
		})).resolves.toBe('changed');
		await expect(fs.readFile(sourcePath, 'utf8')).resolves.toBe('fresh replacement');
		expect(await fs.readdir(uploadPath)).toEqual([]);
	});

	it('absence confirmation restores a file that appears before the atomic claim', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcugame-claim-absence-race-'));
		temporaryRoots.push(root);
		const uploadPath = path.join(root, 'pcugame-upload');
		const sourcePath = path.join(
			root,
			'project-asset-33333333-3333-4333-8333-333333333333',
		);
		const fileSystem = createNodeFileSystem();
		await fileSystem.ensurePrivateDirectory!(uploadPath);
		await fs.writeFile(sourcePath, 'new file');

		await expect(fileSystem.claimAndRemoveFile!(sourcePath, uploadPath)).resolves.toBe('changed');
		await expect(fs.readFile(sourcePath, 'utf8')).resolves.toBe('new file');
		expect(await fs.readdir(uploadPath)).toEqual([]);
	});

	it('rejects a final-component symlink without touching its target', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcugame-private-dir-'));
		temporaryRoots.push(root);
		const target = path.join(root, 'attacker-target');
		const uploadPath = path.join(root, 'pcugame-upload');
		await fs.mkdir(target);
		await fs.symlink(target, uploadPath, 'dir');
		const fileSystem = createNodeFileSystem();

		await expect(fileSystem.ensurePrivateDirectory!(uploadPath))
			.rejects.toThrow('real directory');
		expect(await fs.readdir(target)).toEqual([]);
	});

	it('allows a symlinked parent but secures the final directory to mode 0700', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcugame-private-parent-'));
		temporaryRoots.push(root);
		const realParent = path.join(root, 'real-parent');
		const linkedParent = path.join(root, 'linked-parent');
		await fs.mkdir(realParent);
		await fs.symlink(realParent, linkedParent, 'dir');
		const uploadPath = path.join(linkedParent, 'pcugame-upload');
		const fileSystem = createNodeFileSystem();

		await fileSystem.ensurePrivateDirectory!(uploadPath);
		const result = await fs.lstat(uploadPath);
		expect(result.isDirectory()).toBe(true);
		expect(result.isSymbolicLink()).toBe(false);
		expect(result.uid).toBe(process.getuid?.());
		expect(result.mode & 0o777).toBe(0o700);
	});
});
