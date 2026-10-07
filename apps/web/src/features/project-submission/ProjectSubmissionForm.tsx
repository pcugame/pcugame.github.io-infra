import { useCallback, useState } from 'react';
import { useWatch } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';

import type { SubmitProjectPayloadInput } from '../../contracts/schemas';
import { getApiErrorMessage } from '../../lib/api';
import type { ProjectSubmissionMode } from '../../lib/api/project-submit';
import { getClientUploadLimits, materialUploadLimitsFromConfig } from '../../lib/upload-limits';
import { publicApi } from '../../lib/api';
import { ProjectEditorLayout } from '../../components/project/editor/ProjectEditorLayout';
import { ProjectPreviewModal } from '../../components/project/ProjectPreviewModal';
import { useMe } from '../auth';
import { SubmissionActions } from './SubmissionActions';
import { SubmissionBasicFields } from './SubmissionBasicFields';
import { SubmissionMixedFilesSelection, SubmissionPosterSelection } from './SubmissionFileSelection';
import { SubmissionUploadProgress } from './SubmissionUploadProgress';
import { SubmissionMembersFieldset } from './SubmissionMembersFieldset';
import { useProjectSubmissionForm } from './useProjectSubmissionForm';
import { useSubmissionFiles } from './useSubmissionFiles';

interface ProjectSubmissionFormProps {
	mode: ProjectSubmissionMode;
}

export function ProjectSubmissionForm({ mode }: ProjectSubmissionFormProps) {
	const { user } = useMe();
	const isAdminMode = mode === 'admin';
	const limits = getClientUploadLimits(isAdminMode ? (user?.role ?? 'USER') : 'USER');
	const uploadConfigQuery = useQuery({
		queryKey: ['public-upload-config'],
		queryFn: publicApi.getUploadConfig,
	});
	const materialLimits = materialUploadLimitsFromConfig(uploadConfigQuery.data);
	const files = useSubmissionFiles({ limits, materialLimits });
	const submission = useProjectSubmissionForm({ mode, files });
	const {
		copy,
		cancelSubmission,
		createdProjectId,
		finalizeIfReady,
		canRetryPublication,
		canRetryStatus,
		retryStatus,
		isFinalizing,
		retryPublication,
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
	const [pendingZipCount, setPendingZipCount] = useState(0);
	const title = useWatch({ control, name: 'title' });
	const uploadFinished = useCallback(() => {
		if (createdProjectId) void finalizeIfReady(createdProjectId);
	}, [createdProjectId, finalizeIfReady]);

	const openPreview = () => setPreviewSnapshot(getValues());
	const closePreview = () => setPreviewSnapshot(null);

	return (
		<div className="admin-project-new-page admin-project-edit-page">
			<div className="admin-page-header">
				<div className="admin-page-header__text">
					<span className="admin-page-header__eyebrow">{copy.eyebrow}</span>
					<h1>{copy.title}</h1>
				</div>
			</div>

			<form
				onSubmit={(event) => {
					if (showGameProgress || pendingZipCount > 0) {
						event.preventDefault();
						return;
					}
					void handleSubmit(onSubmit)(event);
				}}
				className="project-form"
			>
				<ProjectEditorLayout
					actions={!showGameProgress && (
						<SubmissionActions
							isSubmitting={isSubmitting}
							blockedReason={pendingZipCount > 0
								? '파일 목록에서 ZIP 용도를 선택하세요.'
								: isUploadLocked
									? '전시회 업로드가 잠겨 있습니다. 운영자에게 문의하세요.'
									: Object.keys(errors).length > 0 ? '표시된 입력 오류를 확인하세요.' : undefined}
							isUploadLocked={isUploadLocked || pendingZipCount > 0}
							onPreview={openPreview}
							submitLabel={copy.submitLabel}
							submittingLabel={copy.submittingLabel}
						/>
					)}
					poster={
						showGameProgress ? (
							<SubmissionUploadProgress
								zone="poster"
								title={title || '작품'}
								projectId={createdProjectId!}
								files={files}
								items={submissionItems}
								onComplete={uploadFinished}
							/>
						) : (
							<SubmissionPosterSelection
								files={files}
								title={title || '작품'}
								limits={limits}
								enabled={!isSubmitting && !isUploadLocked}
							/>
						)
					}
					details={
						showGameProgress ? (
							<section className="project-form-card" aria-label="제출 진행 상태">
								<h2>파일 업로드 및 작품 {isAdminMode ? '등록' : '제출'}</h2>
								<p>선택한 파일을 업로드하고 있습니다. 모든 파일의 검증이 끝나면 작품을 공개합니다.</p>
								<p className="field-hint">
									중간에 끊긴 파일은 동일한 원본 파일을 선택해 이어올릴 수 있습니다.
								</p>
								{submissionError != null && (
									<div className="error-box" role="alert">
										<p>{getApiErrorMessage(submissionError)}</p>
									</div>
								)}
								{canRetryStatus && <button type="button" className="btn btn--primary btn--small" disabled={isFinalizing} onClick={() => void retryStatus()}>제출 상태 다시 확인</button>}
								{import.meta.env.VITE_MOCK === 'true' && canRetryPublication && <button type="button" className="btn btn--primary btn--small" disabled={isFinalizing} onClick={() => void retryPublication()}>Mock 발행 다시 시도</button>}
								<button
									type="button"
									className="btn btn--danger btn--small"
									onClick={() => void cancelSubmission()}
								>
									제출 취소
								</button>
							</section>
						) : (
							<>
								<SubmissionBasicFields
									control={control}
									errors={errors}
									isUploadLocked={isUploadLocked}
									isSubmitting={isSubmitting}
									register={register}
									years={years}
									members={
										<SubmissionMembersFieldset
											append={membersFieldArray.append}
											errors={errors}
											fields={membersFieldArray.fields}
											register={register}
											remove={membersFieldArray.remove}
										/>
									}
								/>

								{files.fileSizeError && (
									<div className="error-box" role="alert">
										<p>{files.fileSizeError}</p>
									</div>
								)}
								{submitMutation.error && (
									<div className="error-box" role="alert">
										<p>{getApiErrorMessage(submitMutation.error)}</p>
									</div>
								)}
							</>
						)
					}
					files={
						showGameProgress ? (
							<SubmissionUploadProgress
								zone="files"
								projectId={createdProjectId!}
								files={files}
								items={submissionItems}
								onComplete={uploadFinished}
							/>
						) : (
							<>
								{uploadConfigQuery.isError && (
									<p role="alert">
										자료 업로드 설정을 불러오지 못했습니다.{' '}
										<button
											type="button"
											className="btn btn--secondary btn--small"
											onClick={() => void uploadConfigQuery.refetch()}
										>
											설정 다시 불러오기
										</button>
									</p>
								)}
								<SubmissionMixedFilesSelection
									files={files}
									limits={limits}
									materialLimits={materialLimits}
									enabled={!isSubmitting && !isUploadLocked}
									onPendingZipChange={setPendingZipCount}
									webglUploadHint={copy.webglUploadHint}
								/>
							</>
						)
					}
				/>
			</form>

			{previewSnapshot && (
				<ProjectPreviewModal
					values={{
						externalLinks: previewSnapshot.externalLinks,
						platforms: previewSnapshot.platforms,
						hardwareRequirements: previewSnapshot.hardwareRequirements,
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
