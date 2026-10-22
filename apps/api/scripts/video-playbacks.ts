import { readFile, appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../src/config/env.js';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';
import { createS3Client } from '../src/lib/s3.js';
import { createObjectStorage } from '../src/lib/storage.js';
import { createBoundedCommandRunner } from '../src/modules/video/command-runner.js';
import { createFfmpegVideoOperations } from '../src/modules/video/ffmpeg-operations.js';
import { DEFAULT_VIDEO_LIMITS, playbackProfiles, playbackRenditions } from '../src/modules/video/policy.js';
import { createPlaybackRepository, sourceVersion } from '../src/modules/video/playback.repository.js';
import { sha256VideoFile } from '../src/modules/video/materialize.js';

interface InventoryEntry { assetId: number; version: string; checksum: string; sourceRate: number; playbackRate: number | null; status: string; sourceWidth?: number; sourceHeight?: number; renditions?: { key: string }[] }
export async function videoPlaybackCommand(args: string[]) {
	const [mode, report] = args;
	if(!['audit', 'enqueue'].includes(mode ?? '') || !report || args.length !== 2) throw new Error('Usage: video-playbacks (audit|enqueue) REPORT.jsonl; audit is read-only, enqueue resumes from a reviewed audit');
	const config = loadEnv();
	const client = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC });
	const operations = createFfmpegVideoOperations(createBoundedCommandRunner(), DEFAULT_VIDEO_LIMITS);
	try {
		if(mode === 'enqueue') {
			const entries = (await readFile(report, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as InventoryEntry);
			const repository = createPlaybackRepository(client);
			for(const row of entries) {
				if(row.status !== 'OK') continue;
				const asset = await client.asset.findUnique({ where: { id: row.assetId }, include: { representations: true, playbackJobs: { include: { renditions: true } } } });
				const source = asset?.representations.find(r => r.role === 'ORIGINAL');
				let status = 'SOURCE_CHANGED';
				if(source && sourceVersion(source) === row.version) {
					const head = await storage.head(source.bucket, source.objectKey);
					if(!head) status = 'MISSING';
					else if(head.size === Number(source.sizeBytes) && (!source.etag || !head.etag || source.etag.replaceAll('"', '') === head.etag.replaceAll('"', ''))) {
                        const expected = row.renditions?.map(r => r.key) ?? (row.sourceWidth && row.sourceHeight ?
                            playbackRenditions({ width: row.sourceWidth, height: row.sourceHeight, frameRate: row.sourceRate }, DEFAULT_VIDEO_LIMITS).map(r => r.key) : null);
                        if (!expected) { console.log(JSON.stringify({ assetId: row.assetId, status: 'AUDIT_REQUIRED' })); continue; }
                        const completed = asset?.playbackJobs.some(j => j.active && j.sourceVersion === row.version && j.sourceSha256 === row.checksum &&
                            expected.every(key => j.renditions.some(r => r.profile === key && r.state === 'READY' && r.expiresAt === null)));
						status = completed ? 'ALREADY_READY' : await repository.enqueue(row.assetId, row.version, row.checksum) ? 'QUEUED' : 'PENDING_OR_CHANGED';
					}
				}
				console.log(JSON.stringify({ assetId: row.assetId, status }));
			}
			return;
		}
		const already = new Set<number>();
		try { for(const line of(await readFile(report, 'utf8')).split('\n').filter(Boolean)) { const row = JSON.parse(line) as InventoryEntry; if(row.status === 'OK') already.add(row.assetId); } }
		catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
		const assets = await client.asset.findMany({ where: { kind: 'VIDEO', status: 'READY' }, include: { representations: true }, orderBy: { id: 'asc' } });
		await mkdir(config.VIDEO_WORKER_TEMP_ROOT, { recursive: true });
		for(const asset of assets) {
			if(already.has(asset.id)) continue;
			const source = asset.representations.find(r => r.role === 'ORIGINAL' && r.state === 'READY');
			const playback = asset.representations.find(r => r.role === 'PLAYBACK' && r.state === 'READY');
			const dir = await mkdtemp(join(config.VIDEO_WORKER_TEMP_ROOT, 'pcu-video-worker-'));
			try {
				if(!source) throw new Error('MISSING_ORIGINAL');
				const inspect = async (r: typeof source, name: string) => {
					const object = await storage.stream(r.bucket, r.objectKey);
					if(!object || 'kind' in object) throw new Error('MISSING_OBJECT');
					if(object.size !== Number(r.sizeBytes)) { object.body.destroy(); throw new Error('SOURCE_CHANGED'); }
					let bytes = 0;
					const path = join(dir, name);
					await pipeline(object.body, new Transform({
						transform(chunk: Buffer, _encoding, callback) {
							bytes += chunk.length;
							callback(bytes > Math.min(DEFAULT_VIDEO_LIMITS.maxSourceBytes, config.VIDEO_WORKER_TEMP_DISK_MB * 1024 * 1024) ? new Error('DISK_BUDGET') : null, chunk);
						}
					}), createWriteStream(path));
					const checksum = await sha256VideoFile(path);
					const probe = await operations.probe(path);
					await operations.verifyDecode(path);
					await rm(path);
					return { checksum, probe, etag: object.etag };
				};
				const original = await inspect(source, 'original');
				if(source.etag && original.etag && source.etag.replaceAll('"', '') !== original.etag.replaceAll('"', '')) throw new Error('SOURCE_CHANGED: etag');
				if(source.checksumAlgorithm === 'SHA256' && source.checksum && source.checksum !== original.checksum && source.checksum !== Buffer.from(original.checksum, 'hex').toString('base64')) throw new Error('SOURCE_CHANGED: checksum');
				const currentRepresentation = await client.assetRepresentation.findUnique({ where: { id: source.id } });
				if(!currentRepresentation || sourceVersion(currentRepresentation) !== sourceVersion(source)) throw new Error('SOURCE_CHANGED: representation');
				const current = await storage.head(source.bucket, source.objectKey);
				if(!current || (original.etag && current.etag !== original.etag)) throw new Error('SOURCE_CHANGED');
				const playing = playback ? await inspect(playback, 'playback').catch(() => null) : null;
				const row = {
					assetId: asset.id, version: sourceVersion(source), checksum: original.checksum,
					sourceRate: original.probe.frameRate, sourceWidth: original.probe.width, sourceHeight: original.probe.height, durationSeconds: original.probe.durationSeconds, playbackRate: playing?.probe.frameRate ?? null,
					profiles: playbackProfiles(Math.max(original.probe.frameRate, original.probe.nominalFrameRate ?? 0)),
                    renditions: playbackRenditions(original.probe, DEFAULT_VIDEO_LIMITS), status: 'OK'
				};
				await appendFile(report, JSON.stringify(row) + '\n');
				console.log(JSON.stringify(row));
			} catch(error) {
				const row = { assetId: asset.id, status: String(error instanceof Error ? error.message : error) };
				await appendFile(report, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
			} finally { await rm(dir, { recursive: true, force: true }); }
		}
	} finally { await client.$disconnect(); s3.destroy(); }
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void videoPlaybackCommand(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1; });
}
