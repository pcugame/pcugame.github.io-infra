import { extname } from 'node:path';
import type { ExportProgress, ExportProgressFile, ExportResult } from '@pcu/contracts';
import type { Readable } from 'node:stream';
import type {
	ClaimedExportJob,
	ExportProjectSnapshot,
	ExportSnapshot,
	ExportSnapshotObject,
} from './ports.js';
import { ExportSnapshotInvariantError } from './repository.js';
import type { NasExportStage } from './nas-staging.adapter.js';

export class ExportSourceMissingError extends Error {
	constructor() {
		super('An object referenced by the export snapshot is missing');
		this.name = 'ExportSourceMissingError';
	}
}

export class ExportSnapshotChangedError extends Error {
	constructor() {
		super('The project changed while its export snapshot was being materialized');
		this.name = 'ExportSnapshotChangedError';
	}
}

interface ExportWorkerRepository {
	claimNext(token: string, leaseMs: number): Promise<ClaimedExportJob | null>;
	heartbeat(input: { id: string; token: string; leaseMs: number; progress: ExportProgress }): Promise<boolean>;
	loadOrCreateSnapshot(job: ClaimedExportJob): Promise<{ snapshot: ExportSnapshot; hash: string }>;
	snapshotStillCurrent(snapshot: ExportSnapshot): Promise<boolean>;
	complete(input: { id: string; token: string; snapshotHash: string; result: ExportResult }): Promise<boolean>;
	retryOrFail(input: {
		id: string; token: string; attemptCount: number; maxAttempts: number;
		error: string; retryDelayMs: number;
	}): Promise<'QUEUED' | 'FAILED' | 'LOST'>;
	failInvariant(input: { id: string; token: string; error: string }): Promise<boolean>;
}

interface ExportObjectReader {
	open(input: { bucket: string; objectKey: string; signal: AbortSignal }): Promise<{
		body: Readable;
		sizeBytes: number;
		etag: string | null;
	} | null>;
}

interface ExportStaging {
	prepare(jobId: string, snapshotHash: string): Promise<NasExportStage>;
	writeObject(input: {
		stage: NasExportStage;
		relativePath: string;
		body: Readable;
		expectedBytes: number;
		maxBytes: number;
		signal?: AbortSignal;
	}): Promise<number>;
	publish(stage: NasExportStage, jobId: string, snapshotHash: string): Promise<string>;
	cleanup(stage: NasExportStage): Promise<void>;
}

interface PlannedObject {
	project: ExportProjectSnapshot;
	object: ExportSnapshotObject;
	relativePath: string;
	fileName: string;
}

function safeComponent(value: string, fallback: string): string {
	const cleaned = value
		.normalize('NFKC')
		.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
		.replace(/[. ]+$/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 100);
	if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
	return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

function extension(object: ExportSnapshotObject): string {
	const candidate = extname(object.originalName).slice(1).toLowerCase();
	if (/^[a-z0-9]{1,10}$/.test(candidate)) return candidate;
	const byMime: Record<string, string> = {
		'application/zip': 'zip',
		'image/jpeg': 'jpg',
		'image/png': 'png',
		'image/webp': 'webp',
		'video/mp4': 'mp4',
		'application/octet-stream': 'bin',
	};
	return byMime[object.mimeType.toLowerCase()] ?? 'bin';
}

function projectDirectory(project: ExportProjectSnapshot): string {
	const exhibition = safeComponent(
		project.exhibition.title ? `${project.exhibition.year}_${project.exhibition.title}` : `${project.exhibition.year}`,
		String(project.exhibition.year),
	);
	const members = [...project.members].sort((a, b) => a.sortOrder - b.sortOrder)
		.map((member) => `${member.studentId}${member.name}`).join('_');
	return `${exhibition}/${safeComponent(members ? `${project.title}_${members}` : project.title, `project_${project.id}`)}`;
}

export function planExport(snapshot: ExportSnapshot): PlannedObject[] {
	const planned: PlannedObject[] = [];
	const occupied = new Set<string>();
	for (const project of snapshot.projects) {
		const count = new Map<string, number>();
		for (const object of project.objects) {
			let fileName: string;
			if (object.role === 'WEBGL_SOURCE') {
				fileName = 'webgl/webgl.zip';
			} else {
				const base = object.role === 'ORIGINAL'
					? object.kind.toLowerCase()
					: `${object.kind.toLowerCase()}_${object.role.toLowerCase()}`;
				const index = count.get(base) ?? 0;
				count.set(base, index + 1);
				fileName = `${base}${index === 0 ? '' : `_${index + 1}`}.${extension(object)}`;
			}
			const relativePath = `${projectDirectory(project)}/${fileName}`;
			const collisionKey = relativePath.normalize('NFC').toLocaleLowerCase('en-US');
			if (occupied.has(collisionKey)) {
				throw new ExportSnapshotInvariantError('DUPLICATE', 'Two export objects resolve to the same portable filename');
			}
			occupied.add(collisionKey);
			planned.push({ project, object, relativePath, fileName });
		}
	}
	return planned;
}

function normalizeEtag(value: string | null): string | null {
	return value?.replace(/^"|"$/g, '') ?? null;
}

function terminalError(error: unknown): boolean {
	return error instanceof ExportSnapshotInvariantError
		|| error instanceof ExportSourceMissingError
		|| error instanceof ExportSnapshotChangedError;
}

function safeFailure(error: unknown): string {
	if (error instanceof ExportSnapshotInvariantError) return `Export snapshot invariant failed (${error.code})`;
	if (error instanceof ExportSourceMissingError || error instanceof ExportSnapshotChangedError) return error.message;
	return 'Export processing failed; retry is scheduled';
}

export function createExportWorker(deps: {
	repository: ExportWorkerRepository;
	reader: ExportObjectReader;
	staging: ExportStaging;
	ids: { next(): string };
	options: {
		concurrency: number;
		leaseMs: number;
		maxObjectBytes: number;
		maxJobBytes: number;
		retryBaseMs: number;
	};
	logger: {
		info(context: Record<string, unknown>, message: string): void;
		warn(context: Record<string, unknown>, message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
}) {
	if (!Number.isInteger(deps.options.concurrency) || deps.options.concurrency < 1 || deps.options.concurrency > 4) {
		throw new RangeError('Export file concurrency must be between 1 and 4');
	}
	if (!Number.isInteger(deps.options.leaseMs) || deps.options.leaseMs < 10_000) {
		throw new RangeError('Export lease must be at least ten seconds');
	}
	if (deps.options.maxObjectBytes < 1 || deps.options.maxJobBytes < deps.options.maxObjectBytes) {
		throw new RangeError('Export byte limits are inconsistent');
	}

	async function process(job: ClaimedExportJob, outerSignal?: AbortSignal): Promise<void> {
		const controller = new AbortController();
		const relayAbort = () => controller.abort(outerSignal?.reason);
		if (outerSignal?.aborted) relayAbort();
		else outerSignal?.addEventListener('abort', relayAbort, { once: true });
		let progress: ExportProgress = {
			year: job.year,
			startedAt: Date.parse(job.createdAt),
			phase: 'preparing', totalProjects: 0, currentProjectIndex: 0,
			currentProjectTitle: null, currentProjectFiles: [], totalFiles: 0,
			downloaded: 0, skipped: 0, failed: 0,
		};
		let heartbeatWork = Promise.resolve(true);
		const pulse = () => {
			heartbeatWork = heartbeatWork.then(() => deps.repository.heartbeat({
				id: job.id, token: job.claimToken, leaseMs: deps.options.leaseMs, progress,
			})).then((owned) => {
				if (!owned) controller.abort(new Error('Export claim lost'));
				return owned;
			}).catch((error) => {
				deps.logger.error({ error, jobId: job.id }, 'Export heartbeat failed');
				controller.abort(error);
				return false;
			});
			return heartbeatWork;
		};
		const timer = setInterval(() => { void pulse(); }, Math.max(1_000, Math.floor(deps.options.leaseMs / 3)));
		let stage: NasExportStage | undefined;
		let published = false;
		try {
			const { snapshot, hash } = await deps.repository.loadOrCreateSnapshot(job);
			const plan = planExport(snapshot);
			progress = { ...progress, totalProjects: snapshot.projects.length, totalFiles: plan.length,
				phase: plan.length === 0 ? 'finishing' : 'downloading' };
			await pulse();
			if (controller.signal.aborted) return;
			const result: ExportResult = {
				projects: snapshot.projects.length, totalFiles: plan.length,
				downloaded: 0, skipped: 0, failed: 0, aborted: false,
				paths: plan.map((item) => `ExportedAssets/${job.id}/${item.relativePath}`),
			};
			if (!job.dryRun) {
				stage = await deps.staging.prepare(job.id, hash);
				if (stage.state === 'READY') {
					result.skipped = plan.length;
					progress = { ...progress, skipped: plan.length, phase: 'finishing' };
				} else {
					let reservedBytes = 0;
					for (let projectIndex = 0; projectIndex < snapshot.projects.length; projectIndex++) {
						const project = snapshot.projects[projectIndex]!;
						const projectFiles = plan.filter((item) => item.project.id === project.id);
						progress = { ...progress, currentProjectIndex: projectIndex,
							currentProjectTitle: project.title,
							currentProjectFiles: projectFiles.map((item): ExportProgressFile => ({
								assetId: item.object.assetId, kind: item.object.kind,
								originalName: item.object.originalName, fileName: item.fileName, status: 'pending',
							})) };
						let cursor = 0;
						const consume = async () => {
							while (!controller.signal.aborted) {
								const index = cursor++;
								const item = projectFiles[index];
								if (!item) return;
								progress.currentProjectFiles[index] = { ...progress.currentProjectFiles[index]!, status: 'saving' };
								const source = await deps.reader.open({
									bucket: item.object.bucket, objectKey: item.object.objectKey, signal: controller.signal,
								});
								if (!source) throw new ExportSourceMissingError();
								if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0
									|| source.sizeBytes > deps.options.maxObjectBytes
									|| (item.object.sizeBytes !== null && item.object.sizeBytes !== source.sizeBytes)
									|| (item.object.etag !== null && normalizeEtag(item.object.etag) !== normalizeEtag(source.etag))) {
									source.body.destroy();
									throw new ExportSnapshotChangedError();
								}
								reservedBytes += source.sizeBytes;
								if (reservedBytes > deps.options.maxJobBytes) {
									source.body.destroy();
									throw new ExportSnapshotInvariantError('MALFORMED', 'Export exceeds its bounded job byte limit');
								}
								await deps.staging.writeObject({ stage: stage!, relativePath: item.relativePath,
									body: source.body, expectedBytes: source.sizeBytes,
									maxBytes: deps.options.maxObjectBytes, signal: controller.signal });
								result.downloaded++;
								progress = { ...progress, downloaded: result.downloaded };
								progress.currentProjectFiles[index] = { ...progress.currentProjectFiles[index]!, status: 'saved' };
							}
						};
						await Promise.all(Array.from({ length: Math.min(deps.options.concurrency, projectFiles.length) }, consume));
						if (controller.signal.aborted) return;
						await pulse();
					}
					if (!await deps.repository.snapshotStillCurrent(snapshot)) throw new ExportSnapshotChangedError();
					progress = { ...progress, phase: 'finishing' };
					await deps.staging.publish(stage, job.id, hash);
					published = true;
				}
			}
			if (!job.dryRun && !published && stage?.state === 'READY') {
				if (!await deps.repository.snapshotStillCurrent(snapshot)) throw new ExportSnapshotChangedError();
			}
			progress = { ...progress, phase: 'finishing' };
			await pulse();
			if (controller.signal.aborted) return;
			if (!await deps.repository.complete({ id: job.id, token: job.claimToken, snapshotHash: hash, result })) {
				throw new Error('Export completion claim was lost');
			}
			deps.logger.info({ jobId: job.id, files: result.totalFiles }, 'Export job completed');
		} catch (error) {
			if (stage && !published) await deps.staging.cleanup(stage).catch((cleanupError) => {
				deps.logger.warn({ cleanupError, jobId: job.id }, 'Failed to clean export staging directory');
			});
			if (controller.signal.aborted || outerSignal?.aborted) return;
			const message = safeFailure(error);
			if (terminalError(error)) {
				await deps.repository.failInvariant({ id: job.id, token: job.claimToken, error: message });
			} else {
				await deps.repository.retryOrFail({ id: job.id, token: job.claimToken,
					attemptCount: job.attemptCount, maxAttempts: job.maxAttempts, error: message,
					retryDelayMs: deps.options.retryBaseMs * (2 ** Math.min(job.attemptCount - 1, 6)) });
			}
			deps.logger.error({ error, jobId: job.id }, 'Export job processing failed');
		} finally {
			clearInterval(timer);
			outerSignal?.removeEventListener('abort', relayAbort);
			await heartbeatWork;
		}
	}

	return {
		async runPass(signal?: AbortSignal): Promise<number> {
			if (signal?.aborted) return 0;
			const job = await deps.repository.claimNext(deps.ids.next(), deps.options.leaseMs);
			if (!job) return 0;
			await process(job, signal);
			return 1;
		},
	};
}
