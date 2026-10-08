import type { SubmitProjectPayloadInput } from '../../contracts/schemas';
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

export function publicAssetRequirementError(visibility: SubmitProjectPayloadInput['visibility'], files: RequiredFiles): string | undefined {
	if ((visibility ?? 'PUBLIC') !== 'PUBLIC') return undefined;
	const missing = submissionAssetChecks(files).filter(check => !check.ready).map(check => check.label);
	return missing.length ? `공개 작품 제출에는 ${missing.join(' · ')} 파일이 필요합니다. 누락된 파일을 선택해주세요.` : undefined;
}
