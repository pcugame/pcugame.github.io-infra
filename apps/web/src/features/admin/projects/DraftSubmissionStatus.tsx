import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminProjectApi, getApiErrorMessage } from '../../../lib/api';
import { invalidateVisibilityQueries, queryKeys, useViewerKey } from '../../../lib/query';
import { uploadKindLabels } from '../../../lib/upload/project-files';

export function DraftSubmissionStatus({ projectId, disabled }: { projectId: number; disabled: boolean }) {
	const qc = useQueryClient();
	const viewerKey = useViewerKey();
	const key = viewerKey(['project-submission', projectId]);
	const status = useQuery({
		queryKey: key,
		queryFn: () => adminProjectApi.getSubmission(projectId),
		refetchInterval: (query) => ['PUBLISHED', 'CANCELLED'].includes(query.state.data?.state ?? '') ? false : 1500,
	});
	const finalize = useMutation({
		mutationFn: () => adminProjectApi.finalizeSubmission(projectId),
		onSuccess: (data) => qc.setQueryData(key, data),
	});
	useEffect(() => {
		if (status.data?.state !== 'PUBLISHED') return;
		void qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) });
		void qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
		void invalidateVisibilityQueries(qc);
	}, [projectId, qc, status.data?.state]);
	const ready = status.data?.state === 'PENDING' && status.data.items.every((item) => item.state === 'READY');
	const error = status.error ?? finalize.error;
	return <div className="admin-card">
		<p>{status.data?.state === 'FINALIZING' ? '제출을 마무리하고 있습니다…' : '임시 저장된 작품입니다. 남은 파일을 업로드하고 적용한 뒤 제출을 완료해 주세요.'}</p>
		{status.data?.items.filter((item) => item.state === 'FAILED').map((item) => <p className="field-error" key={item.id}>{uploadKindLabels[item.kind]}: {item.failureReason ?? '업로드에 실패했습니다. 파일을 다시 선택해 주세요.'}</p>)}
		{error && <p role="alert" className="field-error">{getApiErrorMessage(error)}</p>}
		{status.data?.publicationError && <p role="alert" className="field-error">{status.data.publicationError}</p>}
		<button type="button" className="btn btn--primary" disabled={disabled || !ready || finalize.isPending} onClick={() => finalize.mutate()}>제출 완료</button>
	</div>;
}
