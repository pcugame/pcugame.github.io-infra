import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const scriptUrl = (name: string) => new URL(`./${name}`, import.meta.url);

describe('release script boundary', () => {
	it('keeps operational scripts on canonical migration/reconciliation control-plane paths', async () => {
		const [resources, backfill, preflight, reconcile, releaseMigrate] = await Promise.all([
			readFile(scriptUrl('resources.ts'), 'utf8'),
			readFile(scriptUrl('backfill-canonical-assets.ts'), 'utf8'),
			readFile(scriptUrl('preflight-canonical-contract.ts'), 'utf8'),
			readFile(scriptUrl('reconcile-orphans.ts'), 'utf8'),
			readFile(scriptUrl('release-migrate.ts'), 'utf8'),
		]);

		for (const source of [resources, backfill, preflight, reconcile]) {
			expect(source).not.toContain('project-upload-processing');
			expect(source).not.toContain('createProjectUploadPipeline');
			expect(source).not.toContain('GameUploadSession');
		}
		expect(backfill).toContain('runCanonicalBackfill');
		expect(preflight).toContain('runContractPreflight');
		expect(reconcile).toContain('reconcileObjects');
		expect(releaseMigrate).toContain("const PHASE1_TARGET_MIGRATION = '20260821700000_canonical_object_relocation_expand'");
		expect(releaseMigrate).toContain("const PHASE1_MIGRATION_CEILING = PROJECT_MATERIAL_CONSTRAINTS_MIGRATION");
		expect(releaseMigrate).toContain("const PROJECT_VIDEO_ORDER_MIGRATION = '20260821800000_project_video_order_expand'");
		expect(releaseMigrate).toContain('seedStorageBucketRegistry');
		expect(releaseMigrate).toContain('verifyStorageBucketRegistry');
		expect(releaseMigrate).toContain("S3_BUCKET_PROTECTED");
		expect(releaseMigrate).toContain("S3_BUCKET_PUBLIC");
	});
});
