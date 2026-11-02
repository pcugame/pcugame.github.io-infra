import type { UnrealInspector } from './unreal.js';
import { inspectNativeEngines } from './native-engines.js';
import { renpyScriptEvidence } from './renpy.js';
import { inspectAppleBundles } from './apple.js';
import { androidBundleManifest, androidManifest, dexStructure, protobufFields } from './android.js';
import { nativeEngineCandidates } from './native.js';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
	validateBoundedZipFile,
	ZipValidationError,
	type BoundedZipValidationSummary,
} from '../archive/bounded-zip-validator.js';
import { executableFormat } from './binary.js';
import { openPackageReader, InspectionBudgetExceeded } from './reader.js';
import { inspectWeb } from './web.js';
import type { BuildInspection } from './types.js';

export const isBuildContainer = (path: string) => /\.(?:zip|apk|aab|ipa|nw|jar)$/i.test(path);
interface Budget {
	bytes: number;
	entries: number;
	tempBytes: number;
}
/** ZIP-in-ZIP parsing shares the outer expansion/entry/temp budgets; no executable is launched. */
async function inspectContainers(
	path: string,
	summary: BoundedZipValidationSummary,
	budget: Budget,
	signal?: AbortSignal,
	depth = 0,
): Promise<string[]> {
	const reader = await openPackageReader(path, summary, signal);
	const evidence: string[] = [];
	try {
		for (const file of summary.entries) {
			if (file.isDirectory || file.linkTarget || !isBuildContainer(file.path)) continue;
			if (depth >= 2 || file.decodedBytes > budget.tempBytes)
				throw new ZipValidationError('Nested ZIP exceeds the depth or temporary space budget');
			const directory = await mkdtemp(join(dirname(path), 'container-'));
			try {
				const nestedPath = join(directory, 'payload.zip');
				const entry = reader.entries.get(file.path)!;
				const body = await (
					await import('yauzl')
				).default.openPromise(path, { autoClose: false, lazyEntries: true });
				try {
					// The reader's Entry refers to this immutable source and validated byte range.
					await pipeline(
						await body.openReadStreamPromise(entry),
						createWriteStream(nestedPath, { flags: 'wx', mode: 0o600 }),
						{ signal },
					);
				} finally {
					body.close();
				}
				if (budget.bytes < 1 || budget.entries < 1)
					throw new ZipValidationError('Nested ZIP exceeds cumulative resource budget');
				const nested = await validateBoundedZipFile(nestedPath, {
					profile: 'GAME',
					signal,
					maxArchiveBytes: budget.tempBytes,
					maxEntries: budget.entries,
					maxTotalUncompressedBytes: budget.bytes,
					allowNestedArchivePath: isBuildContainer,
				});
				budget.bytes -= nested.decodedBytes;
				budget.entries -= nested.entryCount;
				const inner = await openPackageReader(nestedPath, nested, signal);
				try {
					const paths = [...inner.entries.keys()];
					if (await renpyScriptEvidence(inner)) evidence.push(`RenPy script payload: ${file.path}`);
					if (
						paths.includes('renpy/bootstrap.py') &&
						/def bootstrap\(/.test((await inner.read('renpy/bootstrap.py')).toString('utf8'))
					)
						evidence.push(`RenPy runtime payload: ${file.path}`);
					if (/\.apk$/i.test(file.path)) {
						const manifest = inner.entries.get('AndroidManifest.xml');
						if (!manifest) throw new ZipValidationError('APK has no AndroidManifest.xml');
						const bytes = await inner.read('AndroidManifest.xml');
						if (bytes.length === manifest.uncompressedSize) {
							const parsed = androidManifest(bytes);
							if (!parsed.application && !parsed.unsupported)
								throw new ZipValidationError('APK manifest has no application');
						}
						let code = false;
						for (const codePath of paths.filter(
							(p) => /^classes\d*\.dex$/.test(p) || /^lib\/[^/]+\/[^/]+\.so$/.test(p),
						)) {
							const entry = inner.entries.get(codePath)!;
							const data = await inner.read(codePath, 256 * 1024);
							if (codePath.endsWith('.dex'))
								code ||= dexStructure(data, entry.uncompressedSize) !== 'invalid';
							else code ||= executableFormat(data, entry.uncompressedSize, true) === 'ELF';
						}
						if (!code) throw new ZipValidationError('APK has no structurally valid application code');
						evidence.push(`Android package: ${file.path} (manifest binding requires review)`);
					} else if (/\.aab$/i.test(file.path)) {
						if (
							!paths.some((p) => /(^|\/)manifest\/AndroidManifest.xml$/.test(p)) ||
							!paths.includes('BundleConfig.pb')
						)
							throw new ZipValidationError('AAB has no bundle manifest/configuration');
						const config = await inner.read('BundleConfig.pb');
						if (config.length === inner.entries.get('BundleConfig.pb')!.uncompressedSize)
							protobufFields(config);
						const manifestPath = paths.includes('base/manifest/AndroidManifest.xml')
							? 'base/manifest/AndroidManifest.xml'
							: paths.find((p) => /(^|\/)manifest\/AndroidManifest.xml$/.test(p))!;
						const manifest = await inner.read(manifestPath);
						if (manifest.length === inner.entries.get(manifestPath)!.uncompressedSize) {
							const parsed = androidBundleManifest(manifest);
							if (!parsed.application && !parsed.unsupported)
								throw new ZipValidationError('AAB manifest has no application');
						}
						let code = false;
						for (const codePath of paths.filter(
							(p) => /^[^/]+\/dex\/classes\d*\.dex$/.test(p) || /^[^/]+\/lib\/[^/]+\/[^/]+\.so$/.test(p),
						)) {
							const entry = inner.entries.get(codePath)!;
							const data = await inner.read(codePath, 256 * 1024);
							code ||= codePath.endsWith('.dex')
								? dexStructure(data, entry.uncompressedSize) !== 'invalid'
								: executableFormat(data, entry.uncompressedSize, true) === 'ELF';
						}
						if (!code) throw new ZipValidationError('AAB has no structurally valid application code');
						evidence.push(`Android App Bundle: ${file.path} (manifest/code binding requires review)`);
					} else if (/\.ipa$/i.test(file.path)) {
						const plist = paths.find((p) => /^Payload\/[^/]+\.app\/Info.plist$/.test(p));
						if (!plist) throw new ZipValidationError('IPA has no application bundle');
						evidence.push(...(await inspectAppleBundles(inner, true)));
						evidence.push(`iOS application bundle: ${file.path} (manifest binding requires review)`);
					} else evidence.push(`Validated internal container: ${file.path}`);
				} catch (error) {
					// Semantic-read limits must never skip structural validation of descendants.
					if (!(error instanceof InspectionBudgetExceeded)) throw error;
					const kind = /\.apk$/i.test(file.path)
						? 'Android package'
						: /\.aab$/i.test(file.path)
							? 'Android App Bundle'
							: /\.ipa$/i.test(file.path)
								? 'iOS application bundle'
								: 'Internal package';
					evidence.push(`${kind}: ${file.path} (${error.message}; requires review)`);
				} finally {
					inner.close();
				}
				const previousTemp = budget.tempBytes;
				budget.tempBytes -= file.decodedBytes;
				try {
					evidence.push(...(await inspectContainers(nestedPath, nested, budget, signal, depth + 1)));
				} finally {
					budget.tempBytes = previousTemp;
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	} finally {
		reader.close();
	}
	return evidence;
}
export async function inspectBuildPackage(input: {
	unrealInspector?: UnrealInspector;
	archivePath: string;
	summary: BoundedZipValidationSummary;
	signal?: AbortSignal;
	tempByteLimit: number;
	selectedEntry?: string | null;
	maxTotalUncompressedBytes?: number;
	maxEntries?: number;
}): Promise<BuildInspection> {
	const result: BuildInspection = {
		version: 'build-package-v1',
		outcome: 'REVIEW',
		engines: [],
		evidence: [],
		reasons: [],
		entryCandidates: [],
		entryPath: null,
		files: input.summary.entries.map((e) => ({
			path: e.path,
			bytes: e.decodedBytes,
		})),
	};
	const budget = {
		bytes: (input.maxTotalUncompressedBytes ?? 10 * 1024 ** 3) - input.summary.decodedBytes,
		entries: (input.maxEntries ?? 10000) - input.summary.entryCount,
		tempBytes: input.tempByteLimit - input.summary.archiveBytes,
	};
	const reader = await openPackageReader(input.archivePath, input.summary, input.signal, budget);
	try {
		result.evidence.push(
			...(await inspectContainers(input.archivePath, input.summary, budget, input.signal)),
		);
		if (input.summary.profile === 'WEBGL') {
			const candidates = await inspectWeb(reader, result.evidence);
			result.entryCandidates = candidates.map((c) => c.path);
			result.engines = [...new Set(candidates.flatMap((c) => c.engines))];
			const confirmed = candidates.filter((c) => c.confirmed);
			const recognized = candidates.filter((c) => c.engines.length > 0);
			const preferred = input.selectedEntry
				? candidates.find((c) => c.path === input.selectedEntry)
				: confirmed.length === 1
					? confirmed[0]
					: recognized.length === 1
						? recognized[0]
						: (candidates.find((c) => c.path === 'index.html') ??
							(candidates.length === 1 ? candidates[0] : undefined));
			if (input.selectedEntry && !preferred)
				throw new ZipValidationError('Selected web entry is not an analyzed candidate');
			if (!candidates.length) {
				result.outcome = 'REJECT';
				result.reasons.push('no-executable-web-entry');
			} else if (!preferred) result.reasons.push('ambiguous-web-entry');
			else {
				result.entryPath = preferred.path;
				result.evidence.push(...preferred.evidence);
				result.reasons.push(...preferred.reasons);
				if (preferred.reasons.some((r) => r.startsWith('missing:'))) result.outcome = 'REJECT';
				else if (preferred.confirmed) result.outcome = 'PASS';
				else result.reasons.push('unverified-web-export');
			}
		} else {
			result.evidence.push(...(await inspectAppleBundles(reader)));
			result.engines = nativeEngineCandidates([...reader.entries.keys()]);
			let executable = false;
			const executables: string[] = [];
			for (const file of input.summary.entries) {
				if (file.isDirectory || file.linkTarget || file.decodedBytes < 32) continue;
				if (
					/\.(mp4|webm|ogg|png|jpg|jpeg|wav|pdb|dll|so|dylib|debug|zip|apk|ipa|aab|pak|pck|ucas|data|rpa)$/i.test(
						file.path,
					)
				)
					continue;
				const prefix = await reader.read(file.path, 64);
				if (
					/\.msi$/i.test(file.path) &&
					prefix.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))
				) {
					const sectorSize = 2 ** prefix.readUInt16LE(30),
						directory = prefix.readUInt32LE(48);
					if (
						[512, 4096].includes(sectorSize) &&
						prefix.readUInt16LE(28) === 0xfffe &&
						file.decodedBytes >= 2 * sectorSize &&
						prefix.readUInt32LE(44) > 0 &&
						(directory + 2) * sectorSize <= file.decodedBytes
					) {
						executable = true;
						result.evidence.push(`Opaque compound installer: ${file.path}`);
					}
					continue;
				}
				if (/\.pkg$/i.test(file.path) && prefix.toString('ascii', 0, 4) === 'xar!') {
					const header = prefix.readUInt16BE(4),
						toc = Number(prefix.readBigUInt64BE(8));
					if (header >= 28 && toc > 0 && Number.isSafeInteger(toc) && header + toc <= file.decodedBytes) {
						executable = true;
						result.evidence.push(`Opaque XAR installer: ${file.path}`);
					}
					continue;
				}
				const magic = prefix.length >= 4 ? prefix.readUInt32LE(0) : 0;
				if (
					![0x00905a4d, 0x464c457f, 0xfeedface, 0xfeedfacf, 0xbebafeca, 0xcffaedfe, 0xfeedface].includes(
						magic,
					) &&
					prefix.toString('ascii', 0, 2) !== 'MZ'
				)
					continue;
				const bytes = await reader.read(file.path, 256 * 1024);
				const format = executableFormat(bytes, file.decodedBytes);
				if (format) {
					executable = true;
					result.evidence.push(`${format} executable: ${file.path}`);
					executables.push(file.path);
				}
			}
			let unreal: Awaited<ReturnType<UnrealInspector>> | undefined;
			if (result.engines.includes('Unreal')) {
				unreal = input.unrealInspector
					? await input.unrealInspector({ reader, archivePath: input.archivePath, tempBytes: budget.tempBytes, executables, signal: input.signal })
					: { outcome: 'REVIEW', evidence: [], reasons: ['ue-inspector-unavailable'] };
				result.evidence.push(...unreal.evidence);
				result.reasons.push(...unreal.reasons);
				// A later optional adapter exhausting its budget cannot downgrade confirmed damage.
				if (unreal.outcome === 'REJECT') {
					result.outcome = 'REJECT';
					return result;
				}
			}
			const mobile = result.evidence.some((e) =>
				/^(Android package|Android App Bundle|iOS application bundle):/.test(e),
			);
			if (!executable && !mobile) {
				result.outcome = 'REJECT';
				result.reasons.push('no-platform-executable');
			} else {
				const confirmed = await inspectNativeEngines(reader, executables, result.evidence);
				result.engines = [...new Set([...result.engines, ...confirmed])];
				if (confirmed.length) result.outcome = 'PASS';
				else result.reasons.push('unverified-native-export');
			}
			if (unreal && result.outcome !== 'REJECT') result.outcome = unreal.outcome;
		}
	} catch (error) {
		if (!(error instanceof InspectionBudgetExceeded)) throw error;
		result.outcome = 'REVIEW';
		result.reasons.push(error.message);
		if (input.summary.profile === 'WEBGL') {
			result.entryCandidates = input.summary.entries
				.filter((e) => !e.isDirectory && /\.html?$/i.test(e.path))
				.map((e) => e.path);
			result.entryPath =
				input.selectedEntry && result.entryCandidates.includes(input.selectedEntry)
					? input.selectedEntry
					: result.entryCandidates.includes('index.html')
						? 'index.html'
						: result.entryCandidates.length === 1
							? result.entryCandidates[0]!
							: null;
		}
	} finally {
		reader.close();
	}
	return result;
}
