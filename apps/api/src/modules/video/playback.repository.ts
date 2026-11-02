import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, AssetRepresentation } from '../../generated/prisma/client.js';
import { withAssetMutationTransaction } from '../assets/mutation-transaction.js';
import { assertNoDeletionClaim } from '../orphan/reference-resolver.js';
import { queueDurableDeletions } from '../orphan/outbox.js';

export function sourceVersion(source: Pick<AssetRepresentation, 'id' | 'bucket' | 'objectKey' | 'sizeBytes' | 'checksum' | 'etag' | 'sourceIdentity' | 'updatedAt'>): string {
	return createHash('sha256').update(JSON.stringify([source.id, source.bucket, source.objectKey,
	String(source.sizeBytes), source.checksum, source.etag, source.sourceIdentity, source.updatedAt.toISOString()])).digest('hex');
}

export async function enqueuePlayback(tx: Prisma.TransactionClient, assetId: number, expectedVersion?: string, sha256?: string): Promise<boolean> {
	const candidate = await tx.asset.findUnique({ where: { id: assetId }, select: { projectId: true } });
	if(candidate?.projectId) await tx.$queryRaw`SELECT id FROM projects WHERE id = ${candidate.projectId} FOR UPDATE`;
	await tx.$queryRaw`SELECT id FROM assets WHERE id = ${assetId} FOR UPDATE`;
	const asset = await tx.asset.findUnique({ where: { id: assetId }, include: { representations: true } });
	const source = asset?.representations.find(r => r.role === 'ORIGINAL' && r.state === 'READY');
	if(!asset || asset.kind !== 'VIDEO' || asset.status !== 'READY' || !source) return false;
	if(await tx.assetUploadSession.findFirst({ where: { resultAssetId: assetId, state: 'VERIFYING' } })) return false;
	if(asset.projectId && await tx.projectSubmission.findFirst({ where: { projectId: asset.projectId, state: 'FINALIZING' } })) return false;
	const version = sourceVersion(source);
	if(expectedVersion && version !== expectedVersion) return false;
	if(await tx.videoPlaybackJob.findFirst({ where: { assetId, state: { in: ['PENDING', 'RUNNING'] } } })) return false;
	await tx.videoPlaybackJob.create({
		data: {
			assetId, sourceRepresentationId: source.id,
			sourceBucket: source.bucket, sourceObjectKey: source.objectKey, sourceVersion: version, sourceSha256: sha256
		}
	});
	return true;
}

export function createPlaybackRepository(client: PrismaClient) {
	const owned = async (tx: Prisma.TransactionClient, id: string, token: string) => {
		const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM video_playback_jobs
   WHERE id = ${id} AND state = 'RUNNING' AND lease_token = ${token} AND lease_until > clock_timestamp() FOR UPDATE`;
		if(rows.length !== 1) throw new Error('Playback lease lost');
		return tx.videoPlaybackJob.findUniqueOrThrow({ where: { id } });
	};
	return {
		enqueue: (id: number, version?: string, sha?: string) => withAssetMutationTransaction(client, tx => enqueuePlayback(tx, id, version, sha)),
		async claim() {
			return client.$transaction(async tx => {
				const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM video_playback_jobs
     WHERE state = 'PENDING' OR (state = 'RUNNING' AND lease_until < clock_timestamp())
     ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
				if(!rows[0]) return null;
				const token = randomUUID();
				await tx.$executeRaw`UPDATE video_playback_jobs SET state = 'RUNNING', lease_token = ${token}, lease_until = clock_timestamp() + interval '120 seconds', attempts = attempts + 1, error = NULL, updated_at = clock_timestamp() WHERE id = ${rows[0].id}`;
				return tx.videoPlaybackJob.findUniqueOrThrow({ where: { id: rows[0].id }, include: { asset: { include: { representations: true } } } });
			});
		},
		async renew(id: string, token: string) {
			const rows = await client.$queryRaw<Array<{ id: string }>>`UPDATE video_playback_jobs SET lease_until = clock_timestamp() + interval '120 seconds'
    WHERE id = ${id} AND lease_token = ${token} AND state = 'RUNNING' AND lease_until > clock_timestamp() RETURNING id`;
			return { count: rows.length };
		},
		bindSource(id: string, token: string, checksum: string) {
			return client.$transaction(async tx => {
				const job = await owned(tx, id, token);
				if(job.sourceSha256 && job.sourceSha256 !== checksum) throw new Error('SOURCE_CHANGED: checksum mismatch');
				await tx.videoPlaybackJob.update({ where: { id }, data: { sourceSha256: checksum } });
			});
		},
		prepare(id: string, token: string, profile: string, bucket: string, objectKey: string) {
			return client.$transaction(async tx => {
				await owned(tx, id, token);
				await assertNoDeletionClaim(tx, { bucket, key: objectKey });
				return tx.videoPlaybackRendition.create({ data: { jobId: id, attempt: token, profile, bucket, objectKey } });
			});
		},
		complete(id: string, token: string, outputs: Array<{ id: string; checksum: string; sizeBytes: bigint; frameRate: number; width: number; height: number }>) {
			return withAssetMutationTransaction(client, async tx => {
				const candidate = await tx.videoPlaybackJob.findUniqueOrThrow({ where: { id }, include: { asset: { select: { projectId: true } } } });
				if(candidate.asset?.projectId) await tx.$queryRaw`SELECT id FROM projects WHERE id = ${candidate.asset.projectId} FOR UPDATE`;
				const job = await owned(tx, id, token);
				if(job.assetId === null) throw new Error('SOURCE_CHANGED: asset deleted');
				await tx.$queryRaw`SELECT id FROM assets WHERE id = ${job.assetId} FOR UPDATE`;
				await tx.$queryRaw`SELECT id FROM asset_representations WHERE asset_id = ${job.assetId} FOR UPDATE`;
				const asset = await tx.asset.findUniqueOrThrow({ where: { id: job.assetId }, include: { representations: true } });
				const source = asset.representations.find(r => r.role === 'ORIGINAL');
				if(asset.status !== 'READY' || !source || source.state !== 'READY' || sourceVersion(source) !== job.sourceVersion) throw new Error('SOURCE_CHANGED: representation replaced');
				const candidates = await tx.videoPlaybackRendition.findMany({ where: { jobId: id, attempt: token, state: 'PENDING' } });
				if(!outputs.length || candidates.length !== outputs.length || candidates.some(r => !outputs.some(o => o.id === r.id))) throw new Error('Incomplete playback set');
				const native = candidates.find(r => r.profile === 'native');
				if(!native) throw new Error('Native playback missing');
				const expiresAt = new Date(Date.now() + 24 * 60 * 60_000);
				await tx.videoPlaybackRendition.updateMany({ where: { job: { assetId: asset.id, active: true }, expiresAt: null }, data: { expiresAt } });
				const old = asset.representations.find(r => r.role === 'PLAYBACK');
				if(old?.state === 'READY' && (old.bucket !== source.bucket || old.objectKey !== source.objectKey)) {
					await tx.videoPlaybackRendition.create({ data: { jobId: id, attempt: token, profile: 'legacy', bucket: old.bucket, objectKey: old.objectKey, state: 'READY', expiresAt, sizeBytes: old.sizeBytes } });
				}
				await tx.videoPlaybackJob.updateMany({ where: { assetId: asset.id, active: true }, data: { active: false } });
				for(const output of outputs) {
					const candidate = candidates.find(r => r.id === output.id)!;
					await assertNoDeletionClaim(tx, { bucket: candidate.bucket, key: candidate.objectKey });
					await tx.videoPlaybackRendition.update({ where: { id: output.id }, data: { ...output, state: 'READY' } });
				}
				const data = outputs.find(o => o.id === native.id)!;
				await tx.assetRepresentation.upsert({
					where: { asset_representation_asset_role: { assetId: asset.id, role: 'PLAYBACK' } },
					create: { assetId: asset.id, role: 'PLAYBACK', bucket: native.bucket, objectKey: native.objectKey, mimeType: 'video/mp4', state: 'READY', sizeBytes: data.sizeBytes, checksumAlgorithm: 'SHA256', checksum: data.checksum, width: data.width, height: data.height },
					update: { bucket: native.bucket, objectKey: native.objectKey, mimeType: 'video/mp4', state: 'READY', error: null, sizeBytes: data.sizeBytes, checksumAlgorithm: 'SHA256', checksum: data.checksum, width: data.width, height: data.height, etag: null, sourceIdentity: null, sourceIdentityAlgorithm: null }
				});
				await tx.videoPlaybackJob.update({ where: { id }, data: { state: 'READY', active: true, leaseToken: null, leaseUntil: null } });
			});
		},
		async fail(id: string, token: string, reason: string) {
			await client.$executeRaw`UPDATE video_playback_jobs SET state = 'FAILED', error = ${reason.slice(0, 2000)}, lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp() WHERE id = ${id} AND lease_token = ${token} AND state = 'RUNNING' AND lease_until > clock_timestamp()`;
		},
		async cleanup() {
			// Rows survive asset deletion (SetNull), so every uploaded object retains a durable cleanup owner.
			return withAssetMutationTransaction(client, async tx => {
				const rows = await tx.videoPlaybackRendition.findMany({
					where: {
						state: { not: 'DELETED' }, OR: [
							{ expiresAt: { lte: new Date() } }, { job: { assetId: null } }, { job: { asset: { status: { in: ['DELETING', 'DELETED'] } } } },
							{ state: 'PENDING', job: { state: { in: ['FAILED', 'READY'] } } },
						]
					}, take: 100
				});
				const stale = await tx.videoPlaybackRendition.findMany({ where: { state: 'PENDING', job: { state: 'RUNNING' } }, take: 100 });
				for(const row of stale) {
					const job = await tx.videoPlaybackJob.findUniqueOrThrow({ where: { id: row.jobId } });
					if(row.attempt !== job.leaseToken) rows.push(row);
				}
				for(const row of rows) {
					// Never enqueue a preserved original merely because a playback version retired.
					const source = await tx.assetRepresentation.findFirst({ where: { role: 'ORIGINAL', bucket: row.bucket, objectKey: row.objectKey, state: { not: 'DELETED' } } });
					if(!source) await queueDurableDeletions(tx, [{ bucket: row.bucket, storageKey: row.objectKey, reason: 'video-playback-retired' }]);
					await tx.videoPlaybackRendition.update({ where: { id: row.id }, data: { state: 'DELETED' } });
				}
			});
		},
	};
}
