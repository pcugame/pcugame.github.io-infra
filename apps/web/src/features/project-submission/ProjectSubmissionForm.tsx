import { useState } from 'react';

import type { SubmitProjectPayloadInput } from '../../contracts/schemas';
import { getApiErrorMessage } from '../../lib/api';
import type { ProjectSubmissionMode } from '../../lib/api/project-submit';
import { getClientUploadLimits } from '../../lib/upload-limits';
import GameUploadWidget from '../../components/GameUploadWidget';
import { ProjectPreviewModal } from '../../components/project/ProjectPreviewModal';
import { useMe } from '../auth';
import { SubmissionActions } from './SubmissionActions';
import { SubmissionBasicFields } from './SubmissionBasicFields';
import { SubmissionFileFieldset } from './SubmissionFileFieldset';
import { SubmissionMembersFieldset } from './SubmissionMembersFieldset';
import { useProjectSubmissionForm } from './useProjectSubmissionForm';
import { useSubmissionFiles } from './useSubmissionFiles';

interface ProjectSubmissionFormProps {
	mode: ProjectSubmissionMode;
}

export function ProjectSubmissionForm({ mode }: ProjectSubmissionFormProps) {
	const { user } = useMe();
	const isAdminMode = mode === 'admin';
	const limits = getClientUploadLimits(isAdminMode ? user?.role ?? 'USER' : 'USER');
	const files = useSubmissionFiles({ limits });
	const submission = useProjectSubmissionForm({ mode, files });
	const {
		copy,
		createdProjectId,
		errors,
		form,
		goToEdit,
		isSubmitting,
		isUploadLocked,
		membersFieldArray,
		onSubmit,
		selectedYearItem,
		showGameProgress,
		submitMutation,
		years,
	} = submission;
	const { control, getValues, handleSubmit, register } = form;
	const [previewSnapshot, setPreviewSnapshot] = useState<SubmitProjectPayloadInput | null>(null);

	const openPreview = () => setPreviewSnapshot(getValues());
	const closePreview = () => setPreviewSnapshot(null);

	return (
		<div className="admin-project-new-page">
			<div className="admin-page-header">
				<div className="admin-page-header__text">
					<span className="admin-page-header__eyebrow">{copy.eyebrow}</span>
					<h1>{copy.title}</h1>
				</div>
			</div>

			{showGameProgress && (
				<GameUploadWidget
					projectId={createdProjectId!}
					initialFile={files.gameFile}
					autoStart
					onComplete={goToEdit}
					onSkip={goToEdit}
				/>
			)}

			{!showGameProgress && (
				<form onSubmit={handleSubmit(onSubmit)} className="project-form">
					<SubmissionBasicFields
						control={control}
						errors={errors}
						isUploadLocked={isUploadLocked}
						register={register}
						years={years}
					/>

					<SubmissionMembersFieldset
						append={membersFieldArray.append}
						errors={errors}
						fields={membersFieldArray.fields}
						register={register}
						remove={membersFieldArray.remove}
					/>

					<SubmissionFileFieldset
						files={files}
						gameUploadHint={copy.gameUploadHint}
						limits={limits}
					/>

					{submitMutation.error && (
						<div className="error-box" role="alert">
							<p>{getApiErrorMessage(submitMutation.error)}</p>
						</div>
					)}

					<SubmissionActions
						isSubmitting={isSubmitting}
						isUploadLocked={isUploadLocked}
						onPreview={openPreview}
						submitLabel={copy.submitLabel}
						submittingLabel={copy.submittingLabel}
					/>
				</form>
			)}

			{previewSnapshot && (
				<ProjectPreviewModal
					values={{
						title: previewSnapshot.title,
						summary: previewSnapshot.summary || undefined,
						description: previewSnapshot.description || undefined,
						members: previewSnapshot.members.map((member) => ({
							name: member.name,
							studentId: member.studentId,
						})),
					}}
					poster={files.posterFile}
					images={files.imageFiles}
					videos={files.videoFiles}
					game={files.gameFile}
					exhibitionLabel={selectedYearItem ? `${selectedYearItem.year}년 전시` : undefined}
					onClose={closePreview}
				/>
			)}
		</div>
	);
}
