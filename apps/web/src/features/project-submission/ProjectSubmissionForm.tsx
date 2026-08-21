import { useEffect, useState } from 'react';

import type { SubmitProjectPayloadInput } from '../../contracts/schemas';
import { getApiErrorMessage } from '../../lib/api';
import type { ProjectSubmissionMode } from '../../lib/api/project-submit';
import { getClientUploadLimits } from '../../lib/upload-limits';
import GameUploadWidget from '../../components/GameUploadWidget';
import DirectVideoUploadWidget from '../../components/DirectVideoUploadWidget';
import DirectImageUploadWidget from '../../components/DirectImageUploadWidget';
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
	const [gameUploadFinished, setGameUploadFinished] = useState(false);
	const [webglUploadFinished, setWebglUploadFinished] = useState(false);
	const [videoUploadFinished, setVideoUploadFinished] = useState(false);
	const [posterUploadFinished, setPosterUploadFinished] = useState(false);
	const [imageUploadFinished, setImageUploadFinished] = useState(false);

	useEffect(() => {
		if (!createdProjectId) return;
		const gameReady = !files.gameFile || gameUploadFinished;
		const webglReady = !files.webglFile || webglUploadFinished;
		const videoReady = files.videoFiles.length === 0 || videoUploadFinished;
		const posterReady = !files.posterFile || posterUploadFinished;
		const imagesReady = files.imageFiles.length === 0 || imageUploadFinished;
		if (gameReady && webglReady && videoReady && posterReady && imagesReady) goToEdit();
	}, [createdProjectId, files.gameFile, files.imageFiles.length, files.posterFile, files.videoFiles.length, files.webglFile, gameUploadFinished, goToEdit, imageUploadFinished, posterUploadFinished, videoUploadFinished, webglUploadFinished]);

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
				<div className="submission-chunked-uploads">
					{files.gameFile && (
						<GameUploadWidget
							projectId={createdProjectId!}
							initialFile={files.gameFile}
							autoStart
							uploadKind="GAME"
							onComplete={() => setGameUploadFinished(true)}
							onSkip={() => setGameUploadFinished(true)}
						/>
					)}
					{files.webglFile && (
						<GameUploadWidget
							projectId={createdProjectId!}
							initialFile={files.webglFile}
							autoStart
							uploadKind="WEBGL"
							onComplete={() => setWebglUploadFinished(true)}
							onSkip={() => setWebglUploadFinished(true)}
						/>
					)}
					{files.videoFiles.length > 0 && (
						<DirectVideoUploadWidget
							projectId={createdProjectId!}
							initialFiles={files.videoFiles}
							autoStart
							onComplete={() => setVideoUploadFinished(true)}
							onSkip={() => setVideoUploadFinished(true)}
						/>
					)}
					{files.posterFile && (
						<DirectImageUploadWidget
							owner={{ type: 'PROJECT', id: createdProjectId! }}
							kind="POSTER"
							initialFiles={[files.posterFile]}
							autoStart
							onComplete={() => setPosterUploadFinished(true)}
						/>
					)}
					{files.imageFiles.length > 0 && (
						<DirectImageUploadWidget
							owner={{ type: 'PROJECT', id: createdProjectId! }}
							kind="IMAGE"
							initialFiles={files.imageFiles}
							autoStart
							onComplete={() => setImageUploadFinished(true)}
						/>
					)}
				</div>
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
						webglUploadHint={copy.webglUploadHint}
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
