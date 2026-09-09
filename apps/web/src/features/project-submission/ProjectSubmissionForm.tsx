import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { SubmitProjectPayloadInput } from '../../contracts/schemas';
import { getApiErrorMessage } from '../../lib/api';
import type { ProjectSubmissionMode } from '../../lib/api/project-submit';
import { getClientUploadLimits, materialUploadLimitsFromConfig } from '../../lib/upload-limits';
import { publicApi } from '../../lib/api';
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
	const { data: uploadConfig } = useQuery({
		queryKey: ['public-upload-config'],
		queryFn: publicApi.getUploadConfig,
	});
	const materialLimits = materialUploadLimitsFromConfig(uploadConfig);
	const files = useSubmissionFiles({ limits, materialLimits });
	const submission = useProjectSubmissionForm({ mode, files });
	const {
		copy,
		cancelSubmission,
		createdProjectId,
		finalizeIfReady,
		errors,
		form,
		isSubmitting,
		isUploadLocked,
		membersFieldArray,
		onSubmit,
		selectedYearItem,
		showGameProgress,
		submitMutation,
		submissionError,
		submissionItems,
		years,
	} = submission;
	const { control, getValues, handleSubmit, register } = form;
	const [previewSnapshot, setPreviewSnapshot] = useState<SubmitProjectPayloadInput | null>(null);
	const itemsFor = (kind: 'GAME' | 'WEBGL' | 'VIDEO' | 'IMAGE' | 'POSTER' | 'DOCUMENT' | 'ATTACHMENT') => submissionItems
		.filter((item) => item.kind === kind)
		.sort((left, right) => left.slot.localeCompare(right.slot, undefined, { numeric: true }));
	const uploadItemsFor = (kind: 'GAME' | 'WEBGL' | 'VIDEO' | 'IMAGE' | 'POSTER' | 'DOCUMENT' | 'ATTACHMENT') => itemsFor(kind)
		.filter((item) => item.state !== 'READY');
	const bindingFor = (kind: 'GAME' | 'WEBGL') => {
		const item = uploadItemsFor(kind)[0];
		return item ? { id: item.id, clientToken: item.clientToken } : undefined;
	};
	const bindingsFor = (kind: 'VIDEO' | 'IMAGE' | 'POSTER' | 'DOCUMENT' | 'ATTACHMENT') => uploadItemsFor(kind)
		.map((item) => ({ id: item.id, clientToken: item.clientToken }));
	const uploadFinished = () => {
		if (createdProjectId) void finalizeIfReady(createdProjectId);
	};

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
					{uploadItemsFor('GAME').length > 0 && (
						<GameUploadWidget
							key={uploadItemsFor('GAME').map((item) => item.id).join(':')}
							projectId={createdProjectId!}
							initialFile={files.gameFile}
							autoStart={Boolean(files.gameFile)}
							uploadKind="GAME"
							submissionItem={bindingFor('GAME')}
							onComplete={uploadFinished}
						/>
					)}
					{uploadItemsFor('WEBGL').length > 0 && (
						<GameUploadWidget
							key={uploadItemsFor('WEBGL').map((item) => item.id).join(':')}
							projectId={createdProjectId!}
							initialFile={files.webglFile}
							autoStart={Boolean(files.webglFile)}
							uploadKind="WEBGL"
							submissionItem={bindingFor('WEBGL')}
							onComplete={uploadFinished}
						/>
					)}
					{uploadItemsFor('VIDEO').length > 0 && (
						<DirectVideoUploadWidget
							key={uploadItemsFor('VIDEO').map((item) => item.id).join(':')}
							projectId={createdProjectId!}
							initialFiles={files.videoFiles}
							autoStart={files.videoFiles.length > 0}
							submissionItems={bindingsFor('VIDEO')}
							onComplete={uploadFinished}
						/>
					)}
					{uploadItemsFor('POSTER').length > 0 && (
						<DirectImageUploadWidget
							key={uploadItemsFor('POSTER').map((item) => item.id).join(':')}
							owner={{ type: 'PROJECT', id: createdProjectId! }}
							kind="POSTER"
							initialFiles={files.posterFile ? [files.posterFile] : []}
							autoStart={Boolean(files.posterFile)}
							submissionItems={bindingsFor('POSTER')}
							onComplete={uploadFinished}
						/>
					)}
					{uploadItemsFor('IMAGE').length > 0 && (
						<DirectImageUploadWidget
							key={uploadItemsFor('IMAGE').map((item) => item.id).join(':')}
							owner={{ type: 'PROJECT', id: createdProjectId! }}
							kind="IMAGE"
							initialFiles={files.imageFiles}
							autoStart={files.imageFiles.length > 0}
							submissionItems={bindingsFor('IMAGE')}
							onComplete={uploadFinished}
						/>
					)}
					{uploadItemsFor('DOCUMENT').length > 0 && materialLimits && (
						<DirectVideoUploadWidget
							key={uploadItemsFor('DOCUMENT').map((item) => item.id).join(':')}
							projectId={createdProjectId!}
							initialFiles={files.documentFiles}
							autoStart={files.documentFiles.length > 0}
							submissionItems={bindingsFor('DOCUMENT')}
							kind="DOCUMENT"
							label="문서"
							accept="text/plain,text/markdown,application/pdf,.txt,.md,.markdown,.pdf,.doc,.docx,.odt,.xls,.xlsx,.ppt,.pptx"
							onComplete={uploadFinished}
						/>
					)}
					{uploadItemsFor('ATTACHMENT').length > 0 && materialLimits && (
						<DirectVideoUploadWidget
							key={uploadItemsFor('ATTACHMENT').map((item) => item.id).join(':')}
							projectId={createdProjectId!}
							initialFiles={files.attachmentFiles}
							autoStart={files.attachmentFiles.length > 0}
							submissionItems={bindingsFor('ATTACHMENT')}
							kind="ATTACHMENT"
							label="첨부자료"
							onComplete={uploadFinished}
						/>
					)}
				</div>
			)}
			{submissionError != null && (
				<div className="error-box" role="alert"><p>{getApiErrorMessage(submissionError)}</p></div>
			)}
			{showGameProgress && (
				<button type="button" className="btn btn--danger btn--small" onClick={() => void cancelSubmission()}>
					제출 취소
				</button>
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
						materialLimits={materialLimits}
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
