import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const apiRoot = new URL('../', import.meta.url);
const read = (path: string) => readFile(new URL(path, apiRoot), 'utf8');

describe('Phase 1 release artifact tree', () => {
	it('ships only the authorized expand migration prefix', async () => {
		const migrations = await readdir(new URL('prisma/migrations/', apiRoot));
		for (const name of [
			'20260821400000_project_submission_draft_status',
			'20260821500000_project_submission_expand',
			'20260821550000_project_submission_finalizing_status',
			'20260821600000_project_publication_expand',
			'20260821700000_canonical_object_relocation_expand',
			'20260821800000_project_video_order_expand',
		]) expect(migrations).toContain(name);
		expect(migrations).not.toContain('20260822000000_canonical_asset_contract');
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
		expect(dockerfile).toContain('ARG VCS_REF');
		expect(dockerfile).toContain('LABEL org.opencontainers.image.revision=$VCS_REF');
		expect(deployWorkflow).toContain('VCS_REF=${{ github.sha }}');
		expect(manifest).toContain("console.log('PCU_PHASE1_RUNTIME_V1')");
		expect(assetsService).toContain('asset_download_legacy_fallback');
		expect(publicBridge).toContain('public_webgl_legacy_bridge');
	});

	it('builds an immutable Phase 1 image without deploying or publishing latest', async () => {
		const workflow = await read('../../.github/workflows/deploy-api.yml');
		expect(workflow).toContain('name: Build Phase 1 API Release Image');
		expect(workflow).toMatch(/^on:\n  workflow_dispatch:\n\npermissions:/m);
		expect(workflow).not.toContain('\n  deploy:');
		expect(workflow).not.toContain(':latest');
		expect(workflow).toContain('id: build');
		expect(workflow).toContain('IMAGE_DIGEST: ${{ steps.build.outputs.digest }}');
		expect(workflow).toContain('immutable_image="${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"');
		expect(workflow).toContain('docker pull "${immutable_image}"');
		expect(workflow).toContain('PCU_PHASE1_RUNTIME_V1');
		expect(workflow).toContain('test ! -e prisma/migrations/20260822000000_canonical_asset_contract');
		expect(workflow).toContain('org.opencontainers.image.revision');
		expect(workflow).toContain('${GITHUB_STEP_SUMMARY}');
	});

	it('does not ship a dispatchable or publishing GitHub Pages workflow', async () => {
		const workflowRoot = new URL('../../.github/workflows/', apiRoot);
		const workflowNames = await readdir(workflowRoot);
		expect(workflowNames).not.toContain('deploy-web-pages.yml');

		const workflowSources = await Promise.all(
			workflowNames
				.filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
				.map((name) => readFile(new URL(name, workflowRoot), 'utf8')),
		);
		const allWorkflows = workflowSources.join('\n');
		for (const publisherMarker of [
			'PAGES_DEPLOY_TOKEN',
			'peaceiris/actions-gh-pages',
			'publish_dir: apps/web/dist',
			'external_repository: pcugame/pcugame.github.io',
			'Deploy Web to GitHub Pages',
		]) expect(allWorkflows).not.toContain(publisherMarker);
		expect(allWorkflows).not.toMatch(/group:\s*['"]?pages['"]?/);
	});
});
