import type { ReactNode } from 'react';
import { WebglBuildGuideLink } from '../WebglBuildGuideLink';
import { SubmissionPosterHelp } from '../../../features/project-submission/SubmissionUploadHelp';
export function StudioFileHeading({ id, label, hint, error, poster, webgl, actions }: {
	id: string; label: string; hint: string; error?: ReactNode; poster?: boolean; webgl?: boolean; actions?: ReactNode;
}) {
	return <legend className="submission-file-heading">
		<span className="submission-file-title"><span id={`${id}-title`}>{label}</span>{poster && <SubmissionPosterHelp studio />}{webgl && <WebglBuildGuideLink />}{actions}</span>
		<span id={`${id}-hint`} className="field-hint">{hint}</span>
		{error && <span id={`${id}-error`} className="field-error" role="alert">{error}</span>}
	</legend>;
}
