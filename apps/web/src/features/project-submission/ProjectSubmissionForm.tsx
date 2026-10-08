import { useState } from 'react';
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
import { SubmissionBackButton } from './SubmissionBackButton';
import { SubmissionActions } from './SubmissionActions';
import { SubmissionBasicFields } from './SubmissionBasicFields';
import { SubmissionMixedFilesSelection, SubmissionPosterSelection } from './SubmissionFileSelection';
import { SubmissionUploadDialog } from './SubmissionUploadDialog';
import { SubmissionMembersFieldset } from './SubmissionMembersFieldset';
import { useProjectSubmissionForm } from './useProjectSubmissionForm';
import { useSubmissionFiles } from './useSubmissionFiles';

interface ProjectSubmissionFormProps {
	mode: ProjectSubmissionMode;
}

export function ProjectSubmissionForm({ mode }: ProjectSubmissionFormProps) {
	const { user } = useMe();
	return <SubmissionForm key={`${mode}:${user?.id ?? 'anonymous'}:${user?.role ?? ''}:${user?.email ?? ''}`} mode={mode} />;
}

function SubmissionForm({ mode }: ProjectSubmissionFormProps) {
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
		errors,
		form,
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
	const [pendingZipCount, setPendingZipCount] = useState(0);
	const title = useWatch({ control, name: 'title' });

	const openPreview = () => setPreviewSnapshot(getValues());
	const closePreview = () => setPreviewSnapshot(null);

	return (
		<div className="admin-project-new-page admin-project-edit-page" inert={isSubmitting || showGameProgress} aria-hidden={isSubmitting || showGameProgress}>
			<div className="admin-page-header">
				<div className="admin-page-header__text">
					<span className="admin-page-header__eyebrow">{copy.eyebrow}</span>
					<h1>{copy.title}</h1>
				</div>
				<SubmissionBackButton mode={mode} isDirty={form.formState.isDirty} files={files} disabled={isSubmitting || showGameProgress} pendingZipCount={pendingZipCount} />
			</div>

			<form
				onSubmit={(event) => {
					if (showGameProgress || pendingZipCount > 0) {
						event.preventDefault();
						return;
					}
					void handleSubmit(onSubmit)(event);
				}}
				inert={isSubmitting || showGameProgress}
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
									: (Object.keys(errors).length > 0 ? '표시된 입력 오류를 확인하세요.' : undefined)}
							isUploadLocked={isUploadLocked || pendingZipCount > 0}
							onPreview={openPreview}
							submitLabel={copy.submitLabel}
							submittingLabel={copy.submittingLabel}
						/>
					)}
					poster={
						<SubmissionPosterSelection
								files={files}
								title={title || '작품'}
								limits={limits}
								enabled={!isSubmitting && !isUploadLocked}
							/>
					}
					details={
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
											swap={membersFieldArray.swap} remove={membersFieldArray.remove}
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
					}
					files={
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
					}
				/>
			</form>

            <SubmissionUploadDialog submission={submission} files={files} title={title || '작품'} />
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
