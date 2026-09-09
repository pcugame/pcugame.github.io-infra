import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Scavenge only mkdtemp directories from a closed grammar.  Symlinks and every
 * foreign entry are deliberately ignored even when their names share a prefix.
 */
export async function cleanupStaleWorkerDirectories(input: {
	tempRoot: string;
	prefix: string;
	cutoff: Date;
}): Promise<number> {
	if (!/^[a-z][a-z0-9-]*-$/.test(input.prefix)) {
		throw new Error('Worker workspace prefix must use the closed lowercase grammar');
	}
	const root = resolve(input.tempRoot);
	let entries;
	try {
		const rootMetadata = await lstat(root);
		if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
			|| await realpath(root) !== root) {
			throw new Error('Worker temp root must be a real directory, not a symlink');
		}
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
		throw error;
	}
	const namePattern = new RegExp(`^${input.prefix}[A-Za-z0-9]{6}$`);
	let removed = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !namePattern.test(entry.name)) continue;
		const directory = join(root, entry.name);
		const metadata = await lstat(directory);
		if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.mtime >= input.cutoff) continue;
		await rm(directory, { recursive: true, force: true });
		removed += 1;
	}
	return removed;
}
