import { useCallback } from 'react';
import { useBeforeUnload, useNavigate } from 'react-router-dom';
import type { ProjectSubmissionMode } from '../../lib/api/project-submit';
import type { SubmissionFilesState } from './useSubmissionFiles';

export function SubmissionBackButton({ mode, isDirty, files, disabled, pendingZipCount = 0 }: {
	mode: ProjectSubmissionMode;
	isDirty: boolean;
	files: SubmissionFilesState;
	disabled: boolean;
	pendingZipCount?: number;
}) {
	const navigate = useNavigate();
	const hasUnsavedInput = isDirty || pendingZipCount > 0 || !!files.posterFile || !!files.gameFile || !!files.webglFile
		|| files.imageFiles.length > 0 || files.videoFiles.length > 0 || files.documentFiles.length > 0 || files.attachmentFiles.length > 0;
	useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
		if (hasUnsavedInput || disabled) { event.preventDefault(); event.returnValue = ''; }
	}, [hasUnsavedInput, disabled]));
	return <button type="button" className="btn btn--secondary" disabled={disabled} onClick={() => {
		if (disabled) return;
		if (hasUnsavedInput && !window.confirm('작성한 내용과 선택한 파일이 저장되지 않습니다. 목록으로 돌아가시겠습니까?')) return;
		navigate(mode === 'admin' ? '/admin/projects' : '/me/projects');
	}}>{mode === 'admin' ? '작품 관리로 돌아가기' : '내 작품으로 돌아가기'}</button>;
}
