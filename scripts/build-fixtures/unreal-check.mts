/** Real exports go through source identity, ZIP safety, the process adapter and GAME state dispatch. */
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameUploadValidationWorker } from '../../apps/api/src/modules/asset-upload/validation-worker.service.ts';
import { createUnrealInspector } from '../../apps/api/src/modules/build-package/unreal.ts';
import { createBoundedCommandRunner } from '../../apps/api/src/modules/process/command-runner.ts';
import { validationSession } from '../../apps/api/src/__tests__/helpers/game-validation-fixture.ts';
import type { AssetUploadRepository } from '../../apps/api/src/modules/asset-upload/ports.ts';
import type { BuildInspection } from '../../apps/api/src/modules/build-package/types.ts';

const catalog = JSON.parse(await readFile('scripts/build-fixtures/unreal.json', 'utf8'));
for (const name of process.argv.slice(2)) {
	const archivePath = join(process.env.UE_FIXTURE_ROOT ?? '/tmp/pcu-ue-exports', name + '.zip');
	const session = validationSession(await readFile(archivePath));
	let held: BuildInspection | undefined, ready = false, rejection: unknown;
	const repository = {
		claimVerifying: async (kind: string) => kind === 'GAME' ? [session] : [],
		renewValidation: async () => true,
		commitGameReady: async () => { ready = true; },
		markRejected: async (...args: unknown[]) => { rejection = args; return true; },
	} as unknown as AssetUploadRepository;
	const root = await mkdtemp(join(tmpdir(), 'pcu-ue-real-worker-'));
	try {
		const worker = createGameUploadValidationWorker({
			repository,
			reviews: { approval: async () => null, awaitReview: async input => { held = input.inspection; return true; } },
			unrealInspector: createUnrealInspector(createBoundedCommandRunner(), process.env.UE_INSPECTOR_PATH ?? '/opt/ue-inspector/UeInspector'),
			storage: { stream: async () => ({ body: createReadStream(archivePath), size: Number(session.totalBytes) }) },
			ids: { next: () => 'actual-ue-export' }, tempRoot: root, tempDiskBudgetBytes: 6 * 1024 ** 3,
			logger: { error: (context, message) => console.error(message, context) }, wakeDeletionWorker() {},
		});
		const counts = await worker.runPass();
		console.log(JSON.stringify({ name, counts, ready, rejection, inspection: held ? { ...held, files: held.files.length } : null }));
		if (catalog.find((record: { name: string }) => record.name === name)?.expected !== held?.outcome || ready || rejection || counts.retried || (await readdir(root)).length)
			throw new Error(`Actual UE worker fixture failed: ${name}`);
	} finally { await rm(root, { recursive: true, force: true }); }
}
