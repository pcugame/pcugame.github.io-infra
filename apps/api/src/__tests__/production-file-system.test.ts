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
