import { StatusBadge } from '../../components/ui';
import { AwardSettings } from '../../features/admin/awards/AwardSettings';
import { publicationReadiness } from '@pcu/contracts';
import { StudioPreview } from '../../features/project-submission/studio/StudioPreview';
import { usePreventWindowClose } from '../../components/common/usePreventWindowClose';
import { effectiveExternalLinks } from '../../components/project/externalLinks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { PROJECT_PLATFORMS, type AdminProjectDetail } from '@pcu/contracts';
import { UpdateProjectFormSchema, type UpdateProjectFormInput } from '../../contracts/schemas';
import { LoadingSpinner, ErrorMessage } from '../../components/common';
import {
	AdminProjectAssetManager,
	AdminProjectUploadProvider,
	useAdminProjectUploadQueue,
} from '../../features/admin/projects/AdminProjectAssetManager';
import { ProjectEditStudio } from '../../components/project/editor/ProjectEditStudio';
import { ProjectPreviewPanel, type PreviewMediaItem } from '../../components/project/ProjectPreviewModal';
import { AdminProjectBasicInfoForm } from '../../features/admin/projects/AdminProjectBasicInfoForm';
import { Button } from '../../components/ui';
import { WebglSettingsDialog } from '../../features/admin/projects/WebglSettingsDialog';
import { WebglDisplaySettingsForm } from '../../features/admin/projects/WebglDisplaySettingsForm';
import { AdminProjectMemberEditor } from '../../features/admin/projects/AdminProjectMemberEditor';
import { PublicationFeedback } from '../../components/project/PublicationFeedback';
import { getProjectSubmitApi } from '../../lib/api/project-submit';
import { useAdminProjectMutations } from '../../features/admin/projects/useAdminProjectMutations';
import { useProjectMemberDraft } from '../../features/admin/projects/useProjectMemberDraft';
import { useMe } from '../../features/auth';
import { adminProjectApi, getApiErrorMessage } from '../../lib/api';
import { queryKeys, invalidateVisibilityQueries } from '../../lib/query';
import { getClientUploadLimits } from '../../lib/upload-limits';

const metadata = (project: AdminProjectDetail): UpdateProjectFormInput => ({
	externalLinks: effectiveExternalLinks(project.externalLinks, project.githubUrl),
	visibility: project.publicationStatus === 'PUBLIC' || project.publicationRequested ? 'PUBLIC' : 'STAFF',
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
		refetchInterval: query => {
			const project = query.state.data;
			if (project?.publicationRequested && !project.publicationError) return 2000;
			return project?.videos.some(video => video.playbackStatus === 'PENDING' || ['PENDING', 'RUNNING'].includes(video.playbackJob?.status ?? '')) ? 5000 : false;
		},
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
 const { user } = useMe();
 const [exceptionReason, setExceptionReason] = useState('');
	const qc = useQueryClient();
	const queue = useAdminProjectUploadQueue();
	const members = useProjectMemberDraft(id, project.members);
	const [baselineStatus, setBaselineStatus] = useState(project.status);
	const [isApplying, setIsApplying] = useState(false);
	const [isSavingDisplay, setIsSavingDisplay] = useState(false);
	const [showWebglSettings, setShowWebglSettings] = useState(false);
	const applyingRef = useRef(false);
	const [applyError, setApplyError] = useState<unknown>(null);
	const [partialFailure, setPartialFailure] = useState(false);
	const [isSuccess, setIsSuccess] = useState(false);
	const [showMemberErrors, setShowMemberErrors] = useState(false);
	const form = useForm<UpdateProjectFormInput>({ resolver: zodResolver(UpdateProjectFormSchema), defaultValues: metadata(project) });
	const values = useWatch({ control: form.control });
	const [step, setStep] = useState(0);
	const [notice, setNotice] = useState('');
	const mutations = useAdminProjectMutations({ projectId: id, project });
	const wantsPublic = values.visibility === 'PUBLIC';
 const currentReadiness = project.publicationReadiness ? (() => {
  const inputs = publicationReadiness({title:values.title ?? '',summary:values.summary,platforms:values.platforms ?? [],members:members.members.map(member=>({name:member.name,studentId:member.studentId ?? ''})),poster:null,assets:[]},user?.role);
  const requirements = project.publicationReadiness.requirements.map(item => ['title','summary','members','platforms'].includes(item.key) ? inputs.requirements.find(input=>input.key===item.key)! : item);
  const blockers = requirements.filter(item=>item.state!=='READY').map(item=>item.key);
  return {...project.publicationReadiness,requirements,blockers,ready:blockers.length===0};
 })() : undefined;
 const needsPublication = wantsPublic && project.publicationStatus !== 'PUBLIC';
 const hasChanges = form.formState.isDirty || members.hasChanges || queue.hasChanges || needsPublication;
	const validChanges = UpdateProjectFormSchema.safeParse(values).success && members.validationErrors.length === 0 && !queue.validationError;
	const pending = isApplying || queue.isApplying || !!queue.active || isSavingDisplay;
	usePreventWindowClose(pending);
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
			setStep(members.validationErrors.length ? 1 : 2);
			const message = members.validationErrors.length ? '참여 학생 정보를 확인하세요.' : queue.validationError ?? '파일을 확인하세요.';
			setNotice(message);
			setApplyError(new Error(message));
			return;
		}
		if (queue.entries.some(entry => entry.status !== 'done' && entry.status !== 'removed')) setStep(2);
		applyingRef.current = true;
		setIsApplying(true);
		queue.setLocked(true);
		try {
			// Apply PRIVATE first so explicitly requested removals cannot degrade a public project.
   if (!wantsPublic && project.publicationStatus === 'PUBLIC') {
    const latest = await adminProjectApi.getDetail(id);
    await mutations.updateMutation.mutateAsync({ publication: { status: 'PRIVATE', expectedVersion: latest.version! } });
   }
   await members.applyChanges();
			if (form.formState.isDirty) {
				const defaults = form.formState.defaultValues;
				const patch = {
					...(JSON.stringify(data.externalLinks) !== JSON.stringify(defaults?.externalLinks) ? { externalLinks: data.externalLinks ?? [] } : {}),
					...(JSON.stringify(data.platforms) !== JSON.stringify(defaults?.platforms) ? { platforms: data.platforms ?? [] } : {}),
					...(data.hardwareRequirements !== defaults?.hardwareRequirements ? { hardwareRequirements: data.hardwareRequirements ?? '' } : {}),
					// Background reads must not turn untouched fields into stale writes.
					...(data.title !== defaults?.title ? { title: data.title } : {}),
					...(data.summary !== defaults?.summary ? { summary: data.summary } : {}),
					...(data.description !== defaults?.description ? { description: data.description } : {}),
					...(data.sortOrder !== defaults?.sortOrder ? { sortOrder: data.sortOrder } : {}),
				};
				const response = Object.keys(patch).length > 0 ? await mutations.updateMutation.mutateAsync(patch) : project;
				form.reset({ ...metadata(response), visibility: data.visibility });
				setBaselineStatus(response.status);
				qc.setQueryData(queryKeys.adminProject(id), response);
			}
   await queue.applyChanges();
   if (wantsPublic) {
    const latest = await adminProjectApi.getDetail(id);
    if (latest.publicationStatus !== 'PUBLIC') {
     await mutations.updateMutation.mutateAsync({ publication: { status: 'PUBLIC', expectedVersion: latest.version!, ...(exceptionReason.trim() ? { exceptionReason: exceptionReason.trim() } : {}) } });
     if (latest.status === 'DRAFT') {
      const api = getProjectSubmitApi(user?.role === 'USER' ? 'user' : 'admin');
      await api.finalizeSubmission(id);
      setNotice('공개 처리 중입니다. 완료 후 상태가 반영됩니다.');
     }
    }
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
	}, invalid => {
		setStep(['title', 'summary', 'description', 'visibility', 'sortOrder'].some(key => key in invalid) ? 0 : 1);
		setNotice('표시된 입력 내용을 확인해주세요. 작성한 내용과 선택한 파일은 유지됩니다.');
	});
	const pendingEntries = (queue.entries ?? []).filter(entry => entry.status === 'pending' || entry.status === 'active');
	const selected = (kind: string) => pendingEntries.filter(entry => entry.kind === kind).flatMap(entry => entry.file instanceof File ? [entry.file] : []);
	const storedAssets = queue.storedAssets ?? project.assets;
	const savedPoster = (queue.removals ?? []).includes(project.posterAssetId ?? -1) || (project.posterAssetId !== undefined && !storedAssets.some(asset => asset.id === project.posterAssetId)) ? undefined : project.poster;
	const savedGame = storedAssets.find(asset => asset.kind === 'GAME' && !(queue.removals ?? []).includes(asset.id));
	const existingMedia = useMemo<PreviewMediaItem[]>(() => {
		const media: PreviewMediaItem[] = [];
		if (savedPoster) media.push({ kind: 'poster-img', url: savedPoster.original.url, image: savedPoster, label: '포스터' });
		for (const asset of storedAssets) {
			if ((queue.removals ?? []).includes(asset.id)) continue;
			if (asset.kind === 'IMAGE') media.push({ kind: 'image', url: asset.image.original.url, image: asset.image, label: asset.originalName });
		}
		for (const video of project.videos) {
			if (storedAssets.some(asset => asset.id === video.assetId) && !(queue.removals ?? []).includes(video.assetId) && video.url) media.push({ kind: 'video', url: video.url, video, name: '등록된 동영상', label: '동영상' });
		}
		return media;
	}, [project, queue.removals, storedAssets, savedPoster]);
 const savedPreview = {
  id: project.id,
  gameDownloadUrl: savedGame && 'url' in savedGame ? savedGame.url : undefined,
  webglUrl: !queue.removeWebgl ? project.webglUrl : undefined,
  awards: project.awards,
  attachments: storedAssets.flatMap(asset =>
   (asset.kind === 'DOCUMENT' || asset.kind === 'ATTACHMENT') && !(queue.removals ?? []).includes(asset.id)
    ? [{ assetId: asset.id, kind: asset.kind, originalName: asset.originalName, mimeType: asset.mimeType, sizeBytes: asset.size, downloadUrl: asset.downloadUrl }] : []),
 };

	const info = { project, form, formId, isPending: pending, canEditContent, onSubmit: onApply };

	return (
		<div className="admin-project-edit-page">

			{form.formState.errors.status && <p className="field-error" role="alert">{form.formState.errors.status.message}</p>}
			{!canEditContent && project.canRequestChange && <div className="admin-card" style={{ marginBottom: '1rem' }}><p className="field-hint">이 작품이 속한 연도는 닫혀 있습니다. 변경 내용은 운영자 승인 후 반영됩니다.</p><Link className="btn btn--primary" to={`/me/projects/${id}/change-request`}>수정 요청 작성</Link></div>}
			<form id={formId} onSubmit={onApply} />
			<ProjectEditStudio title={<>작품 수정{isPrivileged && project.isIncomplete && <StatusBadge size="sm" tone="warning" className="project-edit-header__status">불완전</StatusBadge>}</>} secondaryAction={<Link className="btn btn--secondary project-edit-header__back" to={isPrivileged ? '/admin/projects' : '/me/projects'} onClick={event => { if (pending || (hasChanges && !window.confirm('적용하지 않은 변경사항이 있습니다. 돌아가시겠어요?'))) event.preventDefault(); }} aria-disabled={pending}>{isPrivileged ? '작품 관리로 돌아가기' : '내 작품으로 돌아가기'}</Link>} step={step} onStepChange={next => { setNotice(''); setStep(next); }} disabled={false} notice={notice}
				introduction={<fieldset className="submission-studio__form-guard" disabled={pending}><AdminProjectBasicInfoForm {...info} section="introduction" />{isPrivileged && project.exhibitionId && <AwardSettings exhibitionId={project.exhibitionId} projectId={id} />}
     {wantsPublic && user?.role === 'ADMIN' && <div className="form-field"><label className="form-field__label" htmlFor="publication-exception">예외 공개 사유 (필수 조건 면제 시)</label><textarea className="form-control" id="publication-exception" value={exceptionReason} maxLength={2000} onChange={event => setExceptionReason(event.target.value)} /><p className="field-hint">파일 검증과 접근 권한은 면제되지 않습니다. 사유와 면제 항목이 기록됩니다.</p></div>}
     <PublicationFeedback readiness={currentReadiness} onStep={setStep} />
     {project.publicationError && <p className="field-error" role="alert">{project.publicationError}</p>}</fieldset>}
				game={<AdminProjectBasicInfoForm {...info} section="game" members={<AdminProjectMemberEditor
								members={members.members} canEditContent={canEditContent} isBusy={pending}
								errors={showMemberErrors ? members.validationErrors : []}
								onAdd={members.add} onSwap={members.swap} onUpdate={members.update} onRemove={members.remove}
							/>} />}
				files={<>
					<p className="submission-studio__upload-recommendation">공개하려면 포스터·네이티브 게임·동영상이 필요합니다. WebGL·스크린샷·기타 자료는 선택입니다.</p>
					<AdminProjectAssetManager canEditContent={canEditContent} studio canRetryVideos={isPrivileged} videoRetryDisabled={pending || hasChanges} webglActions={<Button variant="secondary" size="small" aria-label="웹 빌드 설정" aria-haspopup="dialog" disabled={pending} onClick={() => setShowWebglSettings(true)}>설정</Button>} />
				</>}
				preview={<StudioPreview exhibitionSelected values={{ title: values.title ?? '', summary: values.summary, members: members.members }} poster={selected('POSTER').at(-1) ?? null} savedPoster={savedPoster} assetChecks={[
					{ label: '네이티브 빌드', ready: selected('GAME').length > 0 || !!savedGame },
					{ label: '웹 빌드', ready: selected('WEBGL').length > 0 || !!queue.hasWebgl && !queue.removeWebgl },
					{ label: '동영상', ready: selected('VIDEO').length > 0 || existingMedia.some(item => item.kind === 'video') },
					{ label: '사진', ready: selected('IMAGE').length > 0 || existingMedia.some(item => item.kind === 'image') },
				]} exhibitionLabel={`${project.year} 작품 전시`} onPreview={() => setStep(3)} note="작품 정보·학생·파일은 적용 후 반영됩니다." />}

				detail={<ProjectPreviewPanel active={step === 3} values={{ title: values.title ?? '', summary: values.summary, description: values.description, externalLinks: values.externalLinks?.map(link => ({ ...link, label: link.label ?? '', url: link.url ?? '' })), platforms: values.platforms, hardwareRequirements: values.hardwareRequirements, members: members.members }} poster={selected('POSTER').at(-1) ?? null} images={selected('IMAGE')} videos={selected('VIDEO')} game={selected('GAME').at(-1) ?? (savedGame ? { name: savedGame.originalName } : null)} webgl={selected('WEBGL').at(-1) ?? ((queue.hasWebgl || project.webglUrl) && !queue.removeWebgl ? { name: '등록된 웹 빌드' } : null)} saved={savedPreview} existingMedia={existingMedia} exhibitionLabel={`${project.year} 작품 전시`} />}
				feedback={<>
					{applyError != null && <p className="field-error" role="alert">{getApiErrorMessage(applyError)}{partialFailure && ' 일부 변경이 반영되었을 수 있습니다. 남은 변경사항은 다시 적용하세요.'}</p>}
					{isSuccess && !hasChanges && <p className="success-message" role="status">적용되었습니다.</p>}
					{!pending && !applyError && (!canEditContent ? <p className="field-hint">현재 작품을 직접 수정할 권한이 없습니다.</p> : !hasChanges && !isSuccess ? <p className="field-hint">변경사항이 없습니다.</p> : hasChanges ? <p className={queue.validationError ? 'field-error' : 'field-hint'} role={queue.validationError ? 'alert' : undefined}>{queue.validationError ?? '작품 정보·학생·파일은 적용 후 반영됩니다.'}</p> : null)}
					{pending && <p className="field-hint" role="status">변경사항을 적용하고 있습니다…</p>}
				</>}
				actions={<button type="submit" form={formId} className="btn btn--primary" disabled={!canEditContent || !hasChanges || pending || !validChanges}>{pending ? '적용 중…' : !wantsPublic ? '저장' : project.publicationStatus === 'PUBLIC' ? '변경사항 적용' : '공개 제출'}</button>} />
            <WebglSettingsDialog open={showWebglSettings} busy={pending} onClose={() => setShowWebglSettings(false)}>
                <WebglDisplaySettingsForm project={project} isPending={pending} onPendingChange={setIsSavingDisplay} expanded />{isPrivileged && <Link className="btn btn--secondary" to={`/admin/projects/${id}/network`} onClick={event => { if (pending || (hasChanges && !window.confirm('적용하지 않은 변경사항이 있습니다. 외부 연결 관리로 이동할까요?'))) event.preventDefault(); }}>게임 외부 연결 관리</Link>}
            </WebglSettingsDialog>

        </div>
    );
}
