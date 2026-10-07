interface SubmissionActionsProps {
	isSubmitting: boolean;
	blockedReason?: string;
	isUploadLocked: boolean;
	onPreview: () => void;
	submitLabel: string;
	submittingLabel: string;
}

export function SubmissionActions({
	isSubmitting,
	blockedReason,
	isUploadLocked,
	onPreview,
	submitLabel,
	submittingLabel,
}: SubmissionActionsProps) {
	return (
		<div className="project-edit-apply submission-actions" aria-label="작품 제출·등록">
			<div className="project-edit-apply__feedback" aria-live="polite">
				{blockedReason ?? (isSubmitting ? submittingLabel : '포스터·파일은 선택 사항입니다.')}
			</div>
			<button type="submit" className="btn btn--primary" disabled={isSubmitting || isUploadLocked}>
				{isSubmitting ? submittingLabel : submitLabel}
			</button>
			<button type="button" className="btn btn--secondary" onClick={onPreview} disabled={isSubmitting}>
				미리보기
			</button>
		</div>
	);
}
