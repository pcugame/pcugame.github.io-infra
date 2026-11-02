import { StudioFileHeading } from '../../components/project/editor/StudioFileHeading';
import { studioFileHint } from '../../components/project/editor/studioFileHint';
import { useId, useState } from 'react';
import { ProjectPosterPreview } from '../../components/project/editor/ProjectPosterPreview';
import { ProjectUploadDropZone } from '../../components/project/editor/ProjectUploadDropZone';
import { classifyProjectFile } from '../../lib/upload/project-files';
import type { ClientUploadLimits } from '../../lib/upload-limits';
import type { SubmissionFilesState } from './useSubmissionFiles';
import { SubmissionPosterHelp } from './SubmissionUploadHelp';

export function SubmissionPosterSelection({
	files,
	enabled,
	title,
	limits,
	inlineErrors = false,
}: {
	files: SubmissionFilesState;
	enabled: boolean;
	title: string;
	limits: ClientUploadLimits;
	inlineErrors?: boolean;
}) {
	const id = useId();
	const [selectionError, setSelectionError] = useState<string | null>(null);
	const inlineError = inlineErrors ? selectionError ?? files.fileSizeError : null;
	const selectedPoster = files.posterFile && (
		<ul className="project-upload-queue" aria-label="선택한 포스터">
			<li>
				<p title={files.posterFile.name}>
					<strong>{files.posterFile.name}</strong> · 포스터
				</p>
				<button
					type="button"
					className="btn btn--secondary btn--small"
					disabled={!enabled}
					onClick={files.clearPoster}
				>
					선택 취소
				</button>
			</li>
		</ul>
	);
	return (
		<fieldset className="form-section submission-file-fieldset" aria-labelledby={`${id}-title`} aria-describedby={inlineError ? `${id}-error` : undefined}>
			{inlineErrors ? <StudioFileHeading id={id} label="포스터" poster hint={studioFileHint('POSTER', limits)} error={inlineError} /> : <legend className="submission-file-heading">
				<span id={`${id}-title`}>포스터</span>
				<SubmissionPosterHelp />
				{inlineErrors && <span className="field-hint">JPG · PNG · WebP 최대 {limits.posterMaxMb}MB / PDF 최대 {limits.posterPdfMaxMb}MB</span>}
				{inlineError && <span id={`${id}-error`} className="field-error" role="alert">{inlineError}</span>}
			</legend>}
			<ProjectUploadDropZone
				zone="poster"
				compact={inlineErrors}
				enabled={enabled}
				hint={`JPG · PNG · WebP 최대 ${limits.posterMaxMb}MB / PDF 최대 ${limits.posterPdfMaxMb}MB.`}
				onFiles={(selected) => {
					if (selected.length !== 1 || classifyProjectFile(selected[0]!, 'poster') !== 'POSTER') {
						setSelectionError('포스터는 JPG · PNG · WebP · PDF 파일 한 개를 선택하세요.');
						return;
					}
					setSelectionError(null);
					files.selectPoster(selected[0]!);
				}}
				footer={inlineErrors ? <div className="studio-files-scroll" tabIndex={files.posterFile ? 0 : undefined} aria-label="포스터 파일 목록">{selectedPoster}</div> : <>
					{selectionError && <p className="field-error" role="alert">{selectionError}</p>}
					{selectedPoster}
				</>}
			>
				{!inlineErrors && <ProjectPosterPreview title={title} localFile={files.posterFile} />}
			</ProjectUploadDropZone>
		</fieldset>
	);
}
