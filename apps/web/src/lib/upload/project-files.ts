import type { AdminProjectDetail } from '@pcu/contracts';
import type { ClientUploadLimits, MaterialUploadLimits } from '../upload-limits';

export type ProjectUploadKind = 'POSTER' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'ATTACHMENT' | 'GAME' | 'WEBGL';
export type UploadZone = 'poster' | 'files';
export const uploadKindLabels: Record<ProjectUploadKind, string> = {
	POSTER: '포스터',
	IMAGE: '이미지',
	VIDEO: '동영상',
	DOCUMENT: '문서',
	ATTACHMENT: '첨부자료',
	GAME: '게임',
	WEBGL: 'WebGL',
};
const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp']);
const imageMimes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const videoExtensions = new Set(['mp4', 'mov', 'm4v', '3gp', '3g2', 'mkv', 'webm', 'avi', 'wmv', 'asf']);
const videoMimes = new Set([
	'video/mp4',
	'video/quicktime',
	'video/x-m4v',
	'video/3gpp',
	'video/3gpp2',
	'video/matroska',
	'video/x-matroska',
	'video/webm',
	'video/vnd.avi',
	'video/x-msvideo',
	'video/x-ms-wmv',
	'video/x-ms-asf',
]);
const documentExtensions = new Set([
	'pdf',
	'txt',
	'md',
	'markdown',
	'doc',
	'docx',
	'odt',
	'ods',
	'odp',
	'rtf',
	'xls',
	'xlsx',
	'ppt',
	'pptx',
]);
const documentMimes = new Set([
	'application/pdf',
	'text/plain',
	'text/markdown',
	'text/rtf',
	'application/rtf',
	'application/msword',
	'application/vnd.ms-excel',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/vnd.oasis.opendocument.text',
	'application/vnd.oasis.opendocument.spreadsheet',
	'application/vnd.oasis.opendocument.presentation',
]);
export function isPdf(file: Pick<File, 'name' | 'type'>) {
	return file.name.toLowerCase().endsWith('.pdf') || file.type.toLowerCase() === 'application/pdf';
}
/** Classification selects a route only. Existing server validation remains authoritative. */
export function classifyProjectFile(
	file: Pick<File, 'name' | 'type'>,
	zone: UploadZone,
): ProjectUploadKind | 'ZIP' | null {
	const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
	const mime = file.type.toLowerCase();
	const image = imageExtensions.has(extension) || imageMimes.has(mime);
	if (zone === 'poster') return image || isPdf(file) ? 'POSTER' : null;
	if (extension === 'zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed')
		return 'ZIP';
	if (isPdf(file)) return 'DOCUMENT';
	if (image) return 'IMAGE';
	if (videoExtensions.has(extension) || videoMimes.has(mime)) return 'VIDEO';
	if (documentExtensions.has(extension) || documentMimes.has(mime)) return 'DOCUMENT';
	return 'ATTACHMENT';
}
export interface UploadEntry {
	id: number;
	file: File;
	zone: UploadZone;
	kind: ProjectUploadKind | 'ZIP';
	status: 'pending' | 'active' | 'done' | 'cancelled';
}
export const isMaterial = (kind: string) => kind === 'DOCUMENT' || kind === 'ATTACHMENT';
export function uploadQueueIssues(
	entries: UploadEntry[],
	project: AdminProjectDetail,
	limits: ClientUploadLimits,
	material?: MaterialUploadLimits,
): Map<number, string> {
	let videos = new Set([
		...project.videos.map((v) => v.assetId),
		...project.assets.filter((a) => a.kind === 'VIDEO').map((a) => a.id),
	]).size;
	let materials = new Set([
		...(project.attachments ?? []).map((a) => a.assetId),
		...project.assets.filter((a) => isMaterial(a.kind)).map((a) => a.id),
	]).size;
	const issues = new Map<number, string>();
	// Reserve the running file before newly selected ZIPs and pending files.
	for (const entry of [
		...entries.filter((e) => e.status === 'active'),
		...entries.filter((e) => e.status === 'pending'),
	]) {
		const { kind, file } = entry;
		if (kind === 'ZIP') continue;
		let maxBytes: number;
		if (isMaterial(kind)) {
			if (!material) {
				issues.set(entry.id, '자료 업로드 설정을 불러오는 중입니다.');
				continue;
			}
			maxBytes = material.maxBytes;
		} else {
			const mb =
				kind === 'VIDEO'
					? limits.videoMaxMb
					: kind === 'POSTER'
						? isPdf(file)
							? limits.posterPdfMaxMb
							: limits.posterMaxMb
						: kind === 'IMAGE'
							? limits.imageMaxMb
							: limits.gameMaxMb;
			maxBytes = mb * 1024 * 1024;
		}
		if (file.size > maxBytes) {
			issues.set(entry.id, `파일당 최대 ${(maxBytes / 1024 / 1024).toFixed(0)}MB까지 업로드할 수 있습니다.`);
			continue;
		}
		if (kind === 'VIDEO') {
			if (videos >= 5) {
				issues.set(entry.id, '동영상은 대기 중인 파일을 포함해 최대 5개까지 등록할 수 있습니다.');
				continue;
			}
			videos++;
		}
		if (isMaterial(kind) && material) {
			if (materials >= material.maxCount) {
				issues.set(
					entry.id,
					`문서와 첨부자료는 대기 중인 파일을 포함해 최대 ${material.maxCount}개까지 등록할 수 있습니다.`,
				);
				continue;
			}
			materials++;
		}
	}
	return issues;
}
