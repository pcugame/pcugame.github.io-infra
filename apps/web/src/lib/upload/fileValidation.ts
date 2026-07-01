import type { ClientUploadLimits } from '../upload-limits';

export type UploadAssetKind = 'POSTER' | 'IMAGE' | 'VIDEO';

const mb = 1024 * 1024;

export function isPdfFile(file: File): boolean {
	return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

export function formatFileSizeMb(bytes: number): string {
	return (bytes / mb).toFixed(1);
}

export function getAssetLimitMb(
	kind: UploadAssetKind,
	file: File,
	limits: ClientUploadLimits,
): number {
	if (kind === 'VIDEO') return limits.videoMaxMb;
	if (kind === 'POSTER') return isPdfFile(file) ? limits.posterPdfMaxMb : limits.posterMaxMb;
	return isPdfFile(file) ? limits.imagePdfMaxMb : limits.imageMaxMb;
}

export function findOversizedAssetFile(
	kind: UploadAssetKind,
	files: File[],
	limits: ClientUploadLimits,
): File | undefined {
	return files.find((file) => file.size > getAssetLimitMb(kind, file, limits) * mb);
}
