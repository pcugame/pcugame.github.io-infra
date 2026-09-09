import { describe, expect, it, vi } from 'vitest';
import { applyCorrection, correctionManifestHash, prepareCorrection, validateCorrectionCandidates, validatePreparedCorrection } from './canonical-correction.js';
import { assertCorrectionSnapshot } from './canonical-correction.prisma.js';
import type { CorrectionItem, CorrectionManifest, CorrectionObjectStore, CorrectionOutput, CorrectionRepository } from './canonical-correction.types.js';

const hash = 'a'.repeat(64);
function item(): CorrectionItem {
	return { assetId: null, reservedAssetId: 20, projectId: 1, targetKind: 'DOCUMENT', videoSortOrder: null,
		originalName: 'manual.txt', source: { bucket: 'public', key: 'old.txt', mimeType: 'text/plain', sizeBytes: '5', sha256: hash, etag: null },
		ownershipEvidence: { description: 'Exact original match', artifact: 'proof.json', sha256: hash }, outputs: [] };
}
function output(): CorrectionOutput {
	return { role: 'ORIGINAL', bucket: 'protected', objectKey: 'protected/assets/20/original/a.txt', mimeType: 'text/plain', sizeBytes: '5',
		checksumAlgorithm: 'SHA256', checksum: hash, etag: null, sourceIdentityAlgorithm: 'MIGRATION_COPY_SHA256', sourceIdentity: hash,
		width: null, height: null, provenance: { operation: 'COPY', sourceSha256: hash } };
}
function manifest(): CorrectionManifest {
	return { version: 1, id: 'manifest', createdAt: '2026-09-09T00:00:00Z', phase: 'PREPARED', preparedAt: '2026-09-09T00:00:01Z',
		protectedBucket: 'protected', publicBucket: 'public', items: [{ ...item(), outputs: [output()] }],
		snapshots: { projects: [{ id: 1 }], assets: [], representations: [], uploads: [], legacyUploads: [], sourceClaims: [], sourceRepresentations: [] } };
}
function repository(): CorrectionRepository {
	return { snapshot: vi.fn(), reserveAssetId: vi.fn(async () => 20), protect: vi.fn(), materialized: vi.fn(), apply: vi.fn(async () => 'APPLIED' as const) };
}
describe('canonical correction evidence and restart fencing', () => {
	it('rejects missing owner proof, duplicate source ownership and changed poster allowlist identities', () => {
		expect(() => validateCorrectionCandidates([{ ...item(), ownershipEvidence: null }])).toThrow('ownership evidence');
		expect(() => validateCorrectionCandidates([item(), item()])).toThrow('Duplicate source');
		expect(() => validateCorrectionCandidates([{ ...item(), assetId: 51, targetKind: 'POSTER' }])).toThrow('allowlist');
	});
	it('rejects changed original bytes, incomplete video outputs and namespace escapes', () => {
		const changed = manifest(); changed.items[0]!.outputs[0]!.checksum = 'b'.repeat(64);
		expect(() => validatePreparedCorrection(changed)).toThrow('Original bytes');
		const incomplete = manifest(); incomplete.items[0]!.targetKind = 'VIDEO'; incomplete.items[0]!.videoSortOrder = 1;
		expect(() => validatePreparedCorrection(incomplete)).toThrow('Incomplete outputs');
		const escaped = manifest(); escaped.items[0]!.outputs[0]!.objectKey = 'protected/assets/21/original/a.txt';
		expect(() => validatePreparedCorrection(escaped)).toThrow('namespace');
	});
	it('compares full project ownership, all video orders and upload reservation snapshots', () => {
		const planned = manifest();
		expect(() => assertCorrectionSnapshot(planned, planned.snapshots)).not.toThrow();
		for (const key of ['projects', 'assets', 'representations', 'uploads', 'legacyUploads', 'sourceClaims']) {
			const changed = structuredClone(planned.snapshots); (changed[key] as unknown[]).push({ changed: true });
			expect(() => assertCorrectionSnapshot(planned, changed)).toThrow('changed concurrently');
		}
	});
	it('never opens a write transaction for an unreviewed manifest hash', async () => {
		const repo = repository(); const planned = manifest();
		await expect(applyCorrection({ manifest: planned, expectedHash: 'b'.repeat(64), repository: repo,
			objects: { verify: vi.fn(), prepare: vi.fn() } })).rejects.toThrow('hash mismatch');
		expect(repo.apply).not.toHaveBeenCalled();
	});
	it('checks source and destination hashes inside the repository lock boundary', async () => {
		const planned = manifest(); const repo = repository();
		const verify = vi.fn(async () => undefined);
		repo.apply = vi.fn(async (_manifest, verifyObjects) => { expect(verify).not.toHaveBeenCalled(); await verifyObjects(); return 'APPLIED' as const; });
		await applyCorrection({ manifest: planned, expectedHash: correctionManifestHash(planned), repository: repo, objects: { verify, prepare: vi.fn() } });
		expect(verify).toHaveBeenCalledTimes(2);
	});
	it('durably fixes an ID and cleanup intent before staging and reuses it after a crash', async () => {
		const planned = manifest(); planned.phase = 'INVESTIGATED'; planned.items[0]!.outputs = []; delete planned.items[0]!.reservedAssetId;
		const repo = repository(); const checkpoints: CorrectionManifest[] = [];
		let crash = true;
		const objects: CorrectionObjectStore = { verify: vi.fn(), prepare: vi.fn(async (current, _manifest, hooks) => {
			expect(checkpoints.some((checkpoint) => checkpoint.items[0]?.reservedAssetId === 20)).toBe(true);
			await hooks.beforeCreate(output());
			expect(repo.protect).toHaveBeenCalled();
			if (crash) { crash = false; throw new Error('interrupted'); }
			await hooks.afterCreate(output()); return [output()];
		}) };
		const save = async (next: CorrectionManifest) => { checkpoints.push(structuredClone(next)); };
		await expect(prepareCorrection({ manifest: planned, repository: repo, objects, save })).rejects.toThrow('interrupted');
		await prepareCorrection({ manifest: planned, repository: repo, objects, save });
		expect(repo.reserveAssetId).toHaveBeenCalledTimes(1);
		expect(planned.items[0]!.outputs).toHaveLength(1);
		expect(planned.phase).toBe('PREPARED');
	});
});
