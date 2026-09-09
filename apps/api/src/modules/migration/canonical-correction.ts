import { createHash, randomUUID } from 'node:crypto';
import type { CorrectionCandidate, CorrectionItem, CorrectionManifest, CorrectionObjectStore, CorrectionRepository } from './canonical-correction.types.js';

export const POSTER_CORRECTION_LIMITS = Object.freeze({
	maxPixels: 80_000_000, maxDecodedBytes: 320 * 1024 * 1024,
	containerMemoryBytes: 2 * 1024 * 1024 * 1024, concurrency: 1, timeoutMs: 180_000,
});
/** Read-only inventory reviewed for this one-off Phase 1 correction. */
export const POSTER_CORRECTION_ALLOWLIST: Readonly<Record<number, string>> = Object.freeze({
	51: '862ee67d9f04ec699c2311984333a575bee38eeab97b5a7f4d416c7b7a2d5e8e',
	354: '14f504a24ca8fe7770b02d74e7793aa25508e86b1fc13e69788943ad2530c288',
	368: 'd4e70ebadbb5a3378d8b428daf2b5da904f14dd7bdaacd82bfc481d36cb90f36',
	378: '7f9e540c4e2d259759c1625176a95941a3413955523da6870356a57887bd1323',
	402: '0da76f99bf7df015ef05ce5fc860c35c0158b8ea1b302b5a2350ca3dd258d787',
	409: '1edd2d82e682018e3eb496e18641a3b2aeb3c2281c3bf512f28b578ead86eac8',
	421: 'baba1476058238728d1cbaeb06fdb99df7a6dbd913d1adf483788631df3f69c5',
});

export function stableJson(value: unknown): string {
	if (typeof value === 'bigint') return JSON.stringify(value.toString());
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
	return JSON.stringify(value);
}
export function correctionManifestHash(manifest: CorrectionManifest): string {
	return createHash('sha256').update(stableJson(manifest)).digest('hex');
}
export function correctionAssetId(item: CorrectionItem): number {
	const id = item.assetId ?? item.reservedAssetId;
	if (!Number.isSafeInteger(id) || !id || id < 1) throw new Error('New asset ID has not been durably reserved');
	return id;
}
export function validateCorrectionCandidates(items: readonly CorrectionCandidate[]): void {
	if (!items.length) throw new Error('Correction manifest is empty');
	const keys = new Set<string>();
	const ids = new Set<number>();
	const orders = new Set<string>();
	for (const item of items) {
		if (!Number.isSafeInteger(item.projectId) || item.projectId < 1) throw new Error('Unproven project owner');
		if (!['VIDEO', 'POSTER', 'DOCUMENT', 'ATTACHMENT'].includes(item.targetKind)) throw new Error('Unsupported correction kind');
		if (!/^[a-f0-9]{64}$/.test(item.source.sha256) || !/^[1-9][0-9]*$/.test(item.source.sizeBytes)
			|| !item.source.bucket || !item.source.key || !item.source.mimeType || !item.originalName) throw new Error('Source identity is incomplete');
		const source = `${item.source.bucket}\0${item.source.key}`;
		if (keys.has(source)) throw new Error('Duplicate source ownership');
		keys.add(source);
		if (item.assetId !== null) {
			if (!Number.isSafeInteger(item.assetId) || item.assetId < 1 || ids.has(item.assetId)) throw new Error('Duplicate or invalid asset ID');
			ids.add(item.assetId);
		}
		if ((item.assetId === null || item.sourceAlias) && (!item.ownershipEvidence?.description.trim() || !item.ownershipEvidence.artifact.trim()
			|| !/^[a-f0-9]{64}$/.test(item.ownershipEvidence.sha256))) throw new Error('New asset or alias requires reviewed ownership evidence');
		if (item.sourceAlias && item.assetId === null) throw new Error('Alias requires an existing asset');
		if (item.targetKind === 'POSTER' && item.assetId === null) throw new Error('Oversized poster exception requires an existing ID and SHA-256 allowlist');
		if (item.targetKind === 'POSTER' && !item.sourceAlias && POSTER_CORRECTION_ALLOWLIST[item.assetId!] !== item.source.sha256) throw new Error('Poster ID and SHA-256 are outside the correction allowlist');
		if (item.targetKind === 'VIDEO') {
			if (!Number.isSafeInteger(item.videoSortOrder) || item.videoSortOrder === null || item.videoSortOrder < 0) throw new Error('Video order is not fixed');
			const order = `${item.projectId}/${item.videoSortOrder}`;
			if (orders.has(order)) throw new Error('Duplicate target video order');
			orders.add(order);
		} else if (item.videoSortOrder !== null) throw new Error('Only videos may have a video order');
	}
}
export function validatePreparedCorrection(manifest: CorrectionManifest): void {
	if (manifest.version !== 1 || manifest.phase !== 'PREPARED' || !manifest.preparedAt) throw new Error('Manifest is not prepared');
	validateCorrectionCandidates(manifest.items);
	const destinations = new Set<string>();
	for (const item of manifest.items) {
		const id = correctionAssetId(item);
		const roles = item.outputs.map((output) => output.role).sort();
		const required = (item.sourceAlias ? ['ORIGINAL'] : item.targetKind === 'POSTER' ? ['ORIGINAL', 'CARD_480', 'DISPLAY_960']
			: item.targetKind === 'VIDEO' ? ['ORIGINAL', 'PLAYBACK'] : ['ORIGINAL']).sort();
		if (stableJson(roles) !== stableJson(required)) throw new Error(`Incomplete outputs for ${id}`);
		for (const output of item.outputs) {
			const namespace = item.targetKind === 'POSTER' ? `public/images/${id}/` : `protected/assets/${id}/`;
			const bucket = item.targetKind === 'POSTER' ? manifest.publicBucket : manifest.protectedBucket;
			const key = `${output.bucket}\0${output.objectKey}`;
			if (output.bucket !== bucket || !output.objectKey.startsWith(namespace) || destinations.has(key)) throw new Error('Conflicting output namespace');
			destinations.add(key);
			if (output.checksumAlgorithm !== 'SHA256' || !/^[a-f0-9]{64}$/.test(output.checksum ?? '')
				|| !/^[1-9][0-9]*$/.test(output.sizeBytes) || output.provenance.sourceSha256 !== item.source.sha256) throw new Error('Incomplete output provenance');
			if (output.role === 'ORIGINAL' && (output.checksum !== item.source.sha256 || output.sizeBytes !== item.source.sizeBytes
				|| output.provenance.operation !== 'COPY')) throw new Error('Original bytes were changed');
			if (output.role === 'PLAYBACK' && output.mimeType !== 'video/mp4') throw new Error('Playback is not MP4');
			if (output.role === 'CARD_480' || output.role === 'DISPLAY_960') {
				const width = output.role === 'CARD_480' ? 480 : 960;
				if (output.mimeType !== 'image/webp' || !output.width || output.width > width || !output.height) throw new Error('Invalid poster rendition');
			}
		}
	}
}
export async function investigateCorrection(input: { candidates: CorrectionCandidate[]; repository: CorrectionRepository;
	objects: CorrectionObjectStore; protectedBucket: string; publicBucket: string }): Promise<CorrectionManifest> {
	validateCorrectionCandidates(input.candidates);
	for (const item of input.candidates) await input.objects.verify(item.source);
	const snapshots = await input.repository.snapshot([...new Set(input.candidates.map((i) => i.projectId))], input.candidates.map((i) => i.source.key));
	return { version: 1, id: randomUUID(), createdAt: new Date().toISOString(), protectedBucket: input.protectedBucket,
		publicBucket: input.publicBucket, phase: 'INVESTIGATED', snapshots, items: input.candidates.map((item) => ({ ...item, outputs: [] })) };
}
export async function prepareCorrection(input: { manifest: CorrectionManifest; repository: CorrectionRepository; objects: CorrectionObjectStore;
	save(manifest: CorrectionManifest): Promise<void> }): Promise<CorrectionManifest> {
	const { manifest, repository, objects } = input;
	if (!['INVESTIGATED', 'PREPARING', 'PREPARED'].includes(manifest.phase)) throw new Error('Cannot prepare applied manifest');
	validateCorrectionCandidates(manifest.items);
	manifest.phase = 'PREPARING';
	await input.save(manifest);
	for (const item of manifest.items) {
		for (const prepared of manifest.items) for (const output of prepared.outputs) await repository.protect(prepared, output);
		if (item.assetId === null && item.reservedAssetId === undefined) {
			item.reservedAssetId = await repository.reserveAssetId();
			await input.save(manifest);
		}
		await objects.verify(item.source);
		// Sequential processing is also the memory/concurrency boundary for large posters.
		item.outputs = await objects.prepare(item, manifest, {
			async beforeCreate(output) {
				item.outputs = [...item.outputs.filter((existing) => existing.role !== output.role), output];
				await input.save(manifest);
				await repository.protect(item, output);
			},
			afterCreate: (output) => repository.materialized(item, output),
		});
		await input.save(manifest);
	}
	manifest.phase = 'PREPARED';
	manifest.preparedAt = new Date().toISOString();
	validatePreparedCorrection(manifest);
	await input.save(manifest);
	return manifest;
}
export async function applyCorrection(input: { manifest: CorrectionManifest; expectedHash: string; repository: CorrectionRepository;
	objects: CorrectionObjectStore }): Promise<'APPLIED' | 'ALREADY_APPLIED'> {
	if (!/^[a-f0-9]{64}$/.test(input.expectedHash) || correctionManifestHash(input.manifest) !== input.expectedHash) throw new Error('Reviewed manifest hash mismatch');
	validatePreparedCorrection(input.manifest);
	return input.repository.apply(input.manifest, async () => {
		for (const item of input.manifest.items) {
			await input.objects.verify(item.source);
			for (const output of item.outputs) await input.objects.verify({ bucket: output.bucket, key: output.objectKey,
				mimeType: output.mimeType, sizeBytes: output.sizeBytes, sha256: output.checksum!, etag: output.etag });
		}
	});
}
