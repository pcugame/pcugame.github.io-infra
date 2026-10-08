import type { ProjectUploadKind } from '../../../lib/upload/project-files';
import type { SubmissionFilesState } from '../useSubmissionFiles';

export const studioFileGroups = [
	{ id: 'native', label: '네이티브 빌드', kinds: ['GAME'] },
	{ id: 'web', label: '웹 빌드', kinds: ['WEBGL'] },
	{ id: 'video', label: '동영상', kinds: ['VIDEO'] },
	{ id: 'materials', label: '사진·설명문·기타', kinds: ['IMAGE', 'DOCUMENT', 'ATTACHMENT'] },
] as const;
export type StudioFileGroup = (typeof studioFileGroups)[number];
export function selectedStudioFiles(files: SubmissionFilesState): { kind: ProjectUploadKind; file: File }[] {
	return [
		...(files.gameFile ? [{ kind: 'GAME' as const, file: files.gameFile }] : []),
		...(files.webglFile ? [{ kind: 'WEBGL' as const, file: files.webglFile }] : []),
		...files.videoFiles.map(file => ({ kind: 'VIDEO' as const, file })),
		...files.imageFiles.map(file => ({ kind: 'IMAGE' as const, file })),
		...files.documentFiles.map(file => ({ kind: 'DOCUMENT' as const, file })),
		...files.attachmentFiles.map(file => ({ kind: 'ATTACHMENT' as const, file })),
	];
}
