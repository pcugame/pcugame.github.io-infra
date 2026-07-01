interface SubmissionActionsProps {
	isSubmitting: boolean;
	isUploadLocked: boolean;
	onPreview: () => void;
	submitLabel: string;
	submittingLabel: string;
}

export function SubmissionActions({
	isSubmitting,
	isUploadLocked,
	onPreview,
	submitLabel,
	submittingLabel,
}: SubmissionActionsProps) {
	return (
		<div className="form-actions">
			<button
				type="submit"
				className="btn btn--primary btn--large"
				disabled={isSubmitting || isUploadLocked}
			>
				{isSubmitting ? submittingLabel : submitLabel}
			</button>
			<button
				type="button"
				className="btn btn--secondary btn--large"
				onClick={onPreview}
				disabled={isSubmitting}
			>
				미리보기
			</button>
		</div>
	);
}
