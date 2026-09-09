import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const apiRoot = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, apiRoot), 'utf8');

describe('Phase 1 release artifact tree', () => {
	it('retains migration history and omits contract SQL from the Phase 1 image', async () => {
		const migrations = await readdir(new URL('prisma/migrations/', apiRoot));
		for (const name of [
			'20260821400000_project_submission_draft_status',
			'20260821500000_project_submission_expand',
			'20260821550000_project_submission_finalizing_status',
			'20260821600000_project_publication_expand',
			'20260821700000_canonical_object_relocation_expand',
			'20260821800000_project_video_order_expand',
			'20260821900000_project_material_kind_expand',
			'20260821910000_project_material_constraints_expand',
		]) expect(migrations).toContain(name);
		expect(migrations).toContain('20260822000000_canonical_asset_contract');
		const dockerfile = await read('Dockerfile');
		expect(dockerfile).toContain('RUN rm -rf apps/api/prisma/migrations/20260822000000_canonical_asset_contract');
		const submissionExpand = await read('prisma/migrations/20260821500000_project_submission_expand/migration.sql');
		expect(submissionExpand).not.toContain('ALTER COLUMN "status" SET DEFAULT');
	});

	it('keeps an expand-compatible legacy runtime schema', async () => {
		const schema = await read('prisma/schema.prisma');
		for (const legacy of [
			'storageKey         String?',
			'playbackStorageKey String?',
			'model GameUploadSession',
			'model MigrationMetric',
		]) expect(schema).toContain(legacy);
		for (const additive of [
			'DRAFT',
			'model ProjectSubmission',
			'model ProjectPublicationJob',
			'model StorageBucket',
			'model CanonicalObjectRelocation',
			'publicationBucket',
			'stagingBucket',
		]) expect(schema).toContain(additive);
		expect(schema).toContain('status                   ProjectStatus @default(PUBLISHED)');
	});

	it('contains compiled release CLIs, five required workers, manifest, and compatibility telemetry', async () => {
		const [pkg, releaseTsconfig, migrate, dockerfile, deployWorkflow, manifest, assetsService, publicBridge] = await Promise.all([
			read('package.json'), read('tsconfig.release.json'), read('scripts/release-migrate.ts'),
			read('Dockerfile'), read('../../.github/workflows/deploy-api.yml'), read('src/phase1-release-manifest.ts'),
			read('src/modules/assets/service.ts'), read('src/modules/public/delivery-bridge.service.ts'),
		]);
		for (const worker of ['worker:game-validation', 'worker:webgl', 'worker:video', 'worker:image', 'worker:export']) {
			expect(pkg).toContain(worker);
		}
		for (const cli of ['backfill-canonical-assets.ts', 'preflight-canonical-contract.ts', 'release-migrate.ts', 'snapshot-garage-inventory.ts', 'verify-cutover-report.ts']) {
			expect(releaseTsconfig).toContain(cli);
		}
		expect(migrate).toContain("const PHASE1_TARGET_MIGRATION = '20260821700000_canonical_object_relocation_expand'");
		expect(migrate).not.toContain("'apply-contract'");
		expect(dockerfile).toContain('dist-release');
		expect(dockerfile).not.toContain('prisma migrate deploy');
		expect(dockerfile).toContain('ARG RELEASE_SOURCE_SHA');
		expect(dockerfile).toContain('LABEL org.opencontainers.image.revision="${RELEASE_SOURCE_SHA}"');
		expect(deployWorkflow).toContain('RELEASE_SOURCE_SHA=${{ github.sha }}');
		expect(manifest).toContain("console.log('PCU_PHASE1_RUNTIME_V1')");
		expect(assetsService).toContain('asset_download_legacy_fallback');
		expect(publicBridge).toContain('public_webgl_legacy_bridge');
	});

	it('uses the established master build and production release controls', async () => {
		const workflow = await read('../../.github/workflows/deploy-api.yml');
		expect(workflow).toContain('branches: [master]');
		expect(workflow).not.toContain('\n  deploy:');
		expect(workflow).toContain('RELEASE_SOURCE_SHA=${{ github.sha }}');
		expect(workflow).toContain('Record immutable release digest');
		const names = await readdir(new URL('../../.github/workflows/', apiRoot));
		for (const name of ['deploy-web-pages.yml', 'release-api-cutover.yml', 'release-phase1-video-update.yml']) {
			expect(names).toContain(name);
		}
		expect(names).not.toContain('stage-phase1-image.yml');
	});
});
