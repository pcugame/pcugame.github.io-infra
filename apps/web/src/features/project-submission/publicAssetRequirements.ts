import type { SubmissionFilesState } from './useSubmissionFiles';

type RequiredFiles = Pick<SubmissionFilesState, 'gameFile' | 'webglFile' | 'videoFiles' | 'imageFiles'>;

export function submissionAssetChecks(files: RequiredFiles) {
	return [
		{ label: '네이티브 빌드', ready: !!files.gameFile },
		{ label: '웹 빌드', ready: !!files.webglFile },
		{ label: '동영상', ready: files.videoFiles.length > 0 },
		{ label: '사진', ready: files.imageFiles.length > 0 },
	];
}
