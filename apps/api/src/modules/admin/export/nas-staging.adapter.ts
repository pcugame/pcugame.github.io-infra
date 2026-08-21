import { constants, createReadStream } from 'node:fs';
import {
	lstat,
	mkdir,
	open,
	readFile,
	rename,
	rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MANIFEST = '.pcu-export-manifest.json';

function inside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function safeRelativePath(path: string): string {
	if (!path || isAbsolute(path) || path.includes('\0')) throw new Error('Unsafe export relative path');
	const segments = path.replace(/\\/g, '/').split('/');
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new Error('Unsafe export relative path');
	}
	return segments.join('/');
}

function safeComponent(value: string): string {
	const normalized = safeRelativePath(value);
	if (normalized.includes('/')) throw new Error('Unsafe export path component');
	return normalized;
}

async function ensureDirectoryTree(root: string, target: string): Promise<void> {
	if (!inside(root, target)) throw new Error('Export path escaped its configured root');
	await mkdir(target, { recursive: true, mode: 0o700 });
	let cursor = root;
	const child = relative(root, target);
	for (const segment of child ? child.split(sep) : []) {
		cursor = join(cursor, segment);
		const stat = await lstat(cursor);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error('Export path contains a symbolic link or non-directory component');
		}
	}
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, 'r');
	try { await handle.sync(); } finally { await handle.close(); }
}

async function readManifest(path: string): Promise<{ jobId: string; snapshotHash: string } | null> {
	try {
		const parsed = JSON.parse(await readFile(join(path, MANIFEST), 'utf8')) as unknown;
		if (!parsed || typeof parsed !== 'object') return null;
		const value = parsed as { jobId?: unknown; snapshotHash?: unknown };
		return typeof value.jobId === 'string' && typeof value.snapshotHash === 'string'
			? { jobId: value.jobId, snapshotHash: value.snapshotHash }
			: null;
	} catch {
		return null;
	}
}

export interface NasExportStage {
	state: 'STAGING' | 'READY';
	stagingPath: string;
	finalPath: string;
}

/** Worker-only NAS adapter. The configured root must never be an HTTP origin. */
export function createNasExportStaging(deps: {
	outDir: string;
	ids: { next(): string };
	logger: { warn(context: Record<string, unknown>, message: string): void };
}) {
	const root = resolve(deps.outDir);
	const stagingParent = join(root, '.pcu-export-staging');
	const finalParent = join(root, 'ExportedAssets');

	async function prepare(jobId: string, snapshotHash: string): Promise<NasExportStage> {
		const safeJobId = safeComponent(jobId);
		await mkdir(root, { recursive: true, mode: 0o700 });
		const rootStat = await lstat(root);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
			throw new Error('NAS export root must be a real directory');
		}
		await ensureDirectoryTree(root, stagingParent);
		await ensureDirectoryTree(root, finalParent);
		const stagingPath = join(stagingParent, safeJobId);
		const finalPath = join(finalParent, safeJobId);
		const published = await readManifest(finalPath);
		if (published) {
			if (published.jobId !== jobId || published.snapshotHash !== snapshotHash) {
				throw new Error('Existing export directory has a different snapshot manifest');
			}
			return { state: 'READY', stagingPath, finalPath };
		}
		try {
			const stat = await lstat(finalPath);
			if (stat) throw new Error('Existing export directory has no valid manifest');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		await rm(stagingPath, { recursive: true, force: true });
		await mkdir(stagingPath, { mode: 0o700 });
		await syncDirectory(stagingParent);
		return { state: 'STAGING', stagingPath, finalPath };
	}

	async function writeObject(input: {
		stage: NasExportStage;
		relativePath: string;
		body: Readable;
		expectedBytes: number;
		maxBytes: number;
		signal?: AbortSignal;
	}): Promise<number> {
		if (input.stage.state !== 'STAGING') throw new Error('Cannot write an already published export');
		const relativePath = safeRelativePath(input.relativePath);
		const destination = resolve(input.stage.stagingPath, relativePath);
		if (!inside(input.stage.stagingPath, destination)) throw new Error('Export object escaped staging root');
		await ensureDirectoryTree(input.stage.stagingPath, dirname(destination));
		const temporary = `${destination}.${safeComponent(deps.ids.next())}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let written = 0;
		try {
			handle = await open(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			const counter = new Transform({
				transform(chunk, _encoding, callback) {
					written += Buffer.byteLength(chunk);
					if (written > input.maxBytes || written > input.expectedBytes) {
						callback(new Error('Export object exceeds its bounded snapshot size'));
						return;
					}
					callback(null, chunk);
				},
			});
			await pipeline(
				input.body,
				counter,
				handle.createWriteStream({ autoClose: false }),
				...(input.signal ? [{ signal: input.signal }] : []),
			);
			if (written !== input.expectedBytes) throw new Error('Export object size changed from its snapshot');
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, destination);
			await syncDirectory(dirname(destination));
			return written;
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await rm(temporary, { force: true }).catch((cleanupError) => {
				deps.logger.warn({ error: cleanupError, temporary }, 'Failed to remove partial export object');
			});
			throw error;
		}
	}

	async function publish(stage: NasExportStage, jobId: string, snapshotHash: string): Promise<string> {
		if (stage.state === 'READY') return stage.finalPath;
		const manifestPath = join(stage.stagingPath, MANIFEST);
		const handle = await open(
			manifestPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(`${JSON.stringify({ jobId, snapshotHash })}\n`, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		await syncDirectory(stage.stagingPath);
		try {
			await rename(stage.stagingPath, stage.finalPath);
		} catch (error) {
			const existing = await readManifest(stage.finalPath);
			if (existing?.jobId !== jobId || existing.snapshotHash !== snapshotHash) throw error;
			await rm(stage.stagingPath, { recursive: true, force: true });
		}
		await syncDirectory(finalParent);
		return stage.finalPath;
	}

	return {
		prepare,
		writeObject,
		publish,
		readObject: (stage: NasExportStage, relativePath: string) => (
			createReadStream(resolve(stage.finalPath, safeRelativePath(relativePath)))
		),
		cleanup: (stage: NasExportStage) => rm(stage.stagingPath, { recursive: true, force: true }),
	};
}
