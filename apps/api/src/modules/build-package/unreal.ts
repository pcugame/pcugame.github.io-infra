import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CommandLimitError, type BoundedCommandRunner } from '../process/command-runner.js';
import type { PackageReader } from './reader.js';

export const UE_PARSER_REVISION = '605672df7a993a90094bad92d30c388d87ae6c1a';
const responseSchema = z.object({
	version: z.literal(1), inspector: z.literal('ue-inspector-v1'), parserRevision: z.literal(UE_PARSER_REVISION),
	facts: z.array(z.object({
		path: z.string().max(4096), format: z.enum(['pak', 'iostore', 'loose']),
		status: z.enum(['review', 'reject']),
		evidence: z.array(z.string().max(4096)).max(16), reasons: z.array(z.string().max(128)).min(1).max(16),
	}).strict()).max(10000),
}).strict();
export interface UnrealInspection { outcome: 'REVIEW' | 'REJECT'; evidence: string[]; reasons: string[] }
export type UnrealInspector = (input: {
	reader: PackageReader; archivePath: string; tempBytes: number; executables: string[]; signal?: AbortSignal;
}) => Promise<UnrealInspection>;
const candidate = (path: string) => /\.(?:pak|utoc|ucas|uasset|umap|uexp|ubulk|uptnl)$/i.test(path);
const primary = (path: string) => /\.(?:pak|utoc|uasset|umap)$/i.test(path);

/** Worker composition supplies a fixed installed executable; uploaded paths are JSON data only. */
export function createUnrealInspector(runner: BoundedCommandRunner, executable = '/opt/ue-inspector/UeInspector'): UnrealInspector {
	return async (input) => {
		const selected = [...input.reader.entries].filter(([path, entry]) => candidate(path) && !path.endsWith('/') && (entry.externalFileAttributes >>> 16 & 0o170000) !== 0o120000);
		const review = (reason: string): UnrealInspection => ({ outcome: 'REVIEW', evidence: [], reasons: [reason] });
		const required = selected.reduce((total, [, entry]) => total + entry.uncompressedSize, 0);
		// Reserve space for the bounded protocol before creating even the first optional copy.
		const space = await statfs(dirname(input.archivePath), { bigint: true });
		if (!Number.isSafeInteger(required) || required + 1024 * 1024 > input.tempBytes || BigInt(required + 1024 * 1024) > space.bavail * space.bsize)
			return review('ue-temporary-space-budget');
		const analysisBytes = input.reader.remainingAnalysisBytes();
		if (analysisBytes < 1) return review('ue-analysis-budget');
		const directory = await mkdtemp(join(dirname(input.archivePath), 'ue-inspection-'));
		try {
			const files: Array<{ path: string; localPath: string; bytes: number }> = [];
			for (const [path, entry] of selected) {
				input.signal?.throwIfAborted();
				const localPath = join(directory, String(files.length));
				await input.reader.materialize(path, createWriteStream(localPath, { flags: 'wx', mode: 0o600 }));
				files.push({ path, localPath, bytes: entry.uncompressedSize });
			}
			const requestPath = join(directory, 'request.json');
			const request = JSON.stringify({ version: 1, analysisBytes, files });
			if (Buffer.byteLength(request) > 1024 * 1024) return review('ue-protocol-input-budget');
			await writeFile(requestPath, request, { flag: 'wx', mode: 0o600 });
			let stdout: string;
			try {
				({ stdout } = await runner.run({ file: executable, args: [requestPath], timeoutMs: 60_000, maxOutputBytes: 1024 * 1024, signal: input.signal }));
			} catch (error) {
				input.signal?.throwIfAborted();
				if (error instanceof CommandLimitError) return review(`ue-${error.code.toLowerCase()}`);
				throw error;
			}
			// Invalid output is an infrastructure failure and must use the worker's retry path.
			const response = responseSchema.parse(JSON.parse(stdout));
			const expected = files.filter((file) => primary(file.path));
			const paths = new Set(response.facts.map((fact) => fact.path));
			if (paths.size !== response.facts.length || expected.length !== paths.size || expected.some((file) => !paths.has(file.path))
				|| response.facts.some(fact => fact.format !== (/\.pak$/i.test(fact.path) ? 'pak' : /\.utoc$/i.test(fact.path) ? 'iostore' : 'loose')))
				throw new Error('UE inspector returned an incomplete or foreign file inventory');
			return {
				outcome: response.facts.some((fact) => fact.status === 'reject') ? 'REJECT' : 'REVIEW',
				evidence: [`ue-inspector-v1 / CUE4Parse ${UE_PARSER_REVISION}`, ...response.facts.flatMap((fact) => fact.evidence.map((value) => `${fact.path}: ${value}`))],
				reasons: [...new Set([...response.facts.flatMap((fact) => fact.reasons),
					...(input.executables.length ? ['ue-executable-project-binding-unverified'] : []),
					...(!expected.length ? ['ue-orphan-container-data'] : []),
				])],
			};
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	};
}
