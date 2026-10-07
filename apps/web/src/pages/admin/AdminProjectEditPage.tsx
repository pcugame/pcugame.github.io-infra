import { effectiveExternalLinks } from '../../components/project/externalLinks';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { PROJECT_PLATFORMS, type AdminProjectDetail } from '@pcu/contracts';
import { UpdateProjectFormSchema, type UpdateProjectFormInput } from '../../contracts/schemas';
import { LoadingSpinner, ErrorMessage } from '../../components/common';
import {
	AdminProjectAssetManager,
	AdminProjectPosterUpload,
	AdminProjectUploadProvider,
	useAdminProjectUploadQueue,
} from '../../features/admin/projects/AdminProjectAssetManager';
import { ProjectEditorLayout } from '../../components/project/editor';
import { AdminProjectBasicInfoForm } from '../../features/admin/projects/AdminProjectBasicInfoForm';
import { WebglDisplaySettingsForm } from '../../features/admin/projects/WebglDisplaySettingsForm';
import { AdminProjectMemberEditor } from '../../features/admin/projects/AdminProjectMemberEditor';
import { AdminProjectStatusPanel } from '../../features/admin/projects/AdminProjectStatusPanel';
import { DraftSubmissionStatus } from '../../features/admin/projects/DraftSubmissionStatus';
import { useAdminProjectMutations } from '../../features/admin/projects/useAdminProjectMutations';
import { useProjectMemberDraft } from '../../features/admin/projects/useProjectMemberDraft';
import { useMe } from '../../features/auth';
import { adminProjectApi, getApiErrorMessage } from '../../lib/api';
import { queryKeys, invalidateVisibilityQueries } from '../../lib/query';
import { getClientUploadLimits } from '../../lib/upload-limits';

const metadata = (project: AdminProjectDetail): UpdateProjectFormInput => ({
	externalLinks: effectiveExternalLinks(project.externalLinks, project.githubUrl),
	visibility: project.visibility,
	title: project.title,
	summary: project.summary ?? '',
	description: project.description ?? '',
	platforms: PROJECT_PLATFORMS.filter((platform) => project.platforms.includes(platform)),
	hardwareRequirements: project.hardwareRequirements ?? '',
	sortOrder: project.sortOrder,
	status: project.status === 'DRAFT' ? undefined : project.status,
});

export default function AdminProjectEditPage() {
	const { id: idParam } = useParams<{ id: string }>();
	const id = Number(idParam);
	const { user } = useMe();
	const { data: project, isLoading, error, refetch } = useQuery({
		queryKey: queryKeys.adminProject(id),
		queryFn: () => adminProjectApi.getDetail(id),
		enabled: !isNaN(id),
	});
	if (isLoading) return <LoadingSpinner />;
	if (error && !project) return <ErrorMessage error={error} onReset={() => refetch()} />;
	if (!project) return null;
	const isPrivileged = user?.role === 'OPERATOR' || user?.role === 'ADMIN';
	const canEditContent = isPrivileged || project.canEdit === true;
	return (
		<AdminProjectUploadProvider key={id} project={project} projectId={id} limits={getClientUploadLimits(user?.role ?? 'USER')} canEditContent={canEditContent}>
			<ProjectEditor key={id} project={project} isPrivileged={isPrivileged} canEditContent={canEditContent} />
		</AdminProjectUploadProvider>
	);
}

function ProjectEditor({ project, isPrivileged, canEditContent }: { project: AdminProjectDetail; isPrivileged: boolean; canEditContent: boolean }) {
	const id = project.id;
	const qc = useQueryClient();
	const queue = useAdminProjectUploadQueue();
	const members = useProjectMemberDraft(id, project.members);
	const [baselineStatus, setBaselineStatus] = useState(project.status);
	const [isApplying, setIsApplying] = useState(false);
	const [isSavingDisplay, setIsSavingDisplay] = useState(false);
	const applyingRef = useRef(false);
	const [applyError, setApplyError] = useState<unknown>(null);
	const [partialFailure, setPartialFailure] = useState(false);
	const [isSuccess, setIsSuccess] = useState(false);
	const [showMemberErrors, setShowMemberErrors] = useState(false);
	const form = useForm<UpdateProjectFormInput>({ resolver: zodResolver(UpdateProjectFormSchema), defaultValues: metadata(project) });
	const draftStatus = useWatch({ control: form.control, name: 'status' });
	const status = baselineStatus === 'DRAFT' ? 'DRAFT' : draftStatus ?? baselineStatus;
	const mutations = useAdminProjectMutations({ projectId: id, project });
	const hasChanges = form.formState.isDirty || members.hasChanges || queue.hasChanges;
	const pending = isApplying || queue.isApplying || isSavingDisplay;
	const formId = `project-edit-${id}`;
	useEffect(() => {
		if (baselineStatus === 'DRAFT' && project.status !== 'DRAFT') {
			setBaselineStatus(project.status);
			form.resetField('status', { defaultValue: project.status });
		}
	}, [baselineStatus, project.status, form]);

	const onApply = form.handleSubmit(async (data) => {
		if (applyingRef.current || pending || !canEditContent || !hasChanges) return;
		setShowMemberErrors(true);
		setIsSuccess(false);
		setApplyError(null);
		setPartialFailure(false);
		if (members.validationErrors.length || queue.validationError) {
			setApplyError(new Error(queue.validationError ?? '참여 학생 정보를 확인하세요.'));
			return;
		}
		applyingRef.current = true;
		setIsApplying(true);
		queue.setLocked(true);
		try {
			// Existing endpoints are separate. Keep metadata/publication last and checkpoint each completed domain.
			await queue.applyChanges();
			await members.applyChanges();
			if (form.formState.isDirty) {
				const defaults = form.formState.defaultValues;
				const nextStatus = data.status;
				const patch = {
					...(JSON.stringify(data.externalLinks) !== JSON.stringify(defaults?.externalLinks) ? { externalLinks: data.externalLinks ?? [] } : {}),
					...(JSON.stringify(data.platforms) !== JSON.stringify(defaults?.platforms) ? { platforms: data.platforms ?? [] } : {}),
					...(data.hardwareRequirements !== defaults?.hardwareRequirements ? { hardwareRequirements: data.hardwareRequirements ?? '' } : {}),
					// Background reads must not turn untouched fields into stale writes.
					...(project.canChangeVisibility && data.visibility !== defaults?.visibility ? { visibility: data.visibility } : {}),
					...(data.title !== defaults?.title ? { title: data.title } : {}),
					...(data.summary !== defaults?.summary ? { summary: data.summary } : {}),
					...(data.description !== defaults?.description ? { description: data.description } : {}),
					...(data.sortOrder !== defaults?.sortOrder ? { sortOrder: data.sortOrder } : {}),
					...(isPrivileged && baselineStatus !== 'DRAFT' && nextStatus !== baselineStatus ? { status: nextStatus } : {}),
				};
				const response = Object.keys(patch).length > 0 ? await mutations.updateMutation.mutateAsync(patch) : project;
				form.reset(metadata(response));
				setBaselineStatus(response.status);
				qc.setQueryData(queryKeys.adminProject(id), response);
			}
			await qc.invalidateQueries({ queryKey: queryKeys.adminProject(id) });
			await qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
			await invalidateVisibilityQueries(qc, { preserveProjectDrafts: true });
			setIsSuccess(true);
		} catch (error) {
			setApplyError(error);
			setPartialFailure(true);
		} finally {
			queue.setLocked(false);
			applyingRef.current = false;
			setIsApplying(false);
		}
	});


	return (
		<div className="admin-project-edit-page">
			<div className="admin-page-header">
				<div className="admin-page-header__text"><h1>작품 수정{isPrivileged && project.isIncomplete && <span className="incomplete-badge">불완전</span>}</h1></div>
				<AdminProjectStatusPanel status={status} isPrivileged={isPrivileged} isPending={pending} error={null} onToggle={(next) => form.setValue('status', next, { shouldDirty: true, shouldValidate: true })} />
			</div>
			{form.formState.errors.status && <p className="field-error" role="alert">{form.formState.errors.status.message}</p>}
			{project.status === 'DRAFT' && canEditContent && <DraftSubmissionStatus projectId={id} disabled={pending || hasChanges} />}
			{!canEditContent && project.canRequestChange && <div className="admin-card" style={{ marginBottom: '1rem' }}><p>이 작품이 속한 연도는 닫혀 있습니다. 변경 내용은 운영자 승인 후 반영됩니다.</p><Link className="btn btn--primary" to={`/me/projects/${id}/change-request`}>수정 요청 작성</Link></div>}
			<ProjectEditorLayout
				poster={<AdminProjectPosterUpload project={project} canEditContent={canEditContent} />}
				details={<>
					<AdminProjectBasicInfoForm project={project} form={form} formId={formId} isPending={pending} canEditContent={canEditContent} onSubmit={onApply} />
					<WebglDisplaySettingsForm project={project} isPending={pending} onPendingChange={setIsSavingDisplay} />
					<AdminProjectMemberEditor members={members.members} canEditContent={canEditContent} isBusy={pending} errors={showMemberErrors ? members.validationErrors : []} onAdd={members.add} onSwap={members.swap} onUpdate={members.update} onRemove={members.remove} />
				</>}
				files={<AdminProjectAssetManager canEditContent={canEditContent} />}
			/>
			<div className="project-edit-apply" aria-label="작품 변경사항 적용">
				<div className="project-edit-apply__feedback" aria-live="polite">
					{applyError != null && <p className="field-error" role="alert">{getApiErrorMessage(applyError)}{partialFailure && ' 일부 변경이 반영되었을 수 있습니다. 남은 변경사항은 다시 적용하세요.'}</p>}
					{isSuccess && !hasChanges && <p className="success-message">적용되었습니다.</p>}
					{pending && <p role="status">변경사항을 적용하고 있습니다…</p>}
				</div>
				<button type="submit" form={formId} className="btn btn--primary" disabled={!canEditContent || !hasChanges || pending}>{pending ? '적용 중…' : '적용'}</button>
			</div>
		</div>
	);
}
