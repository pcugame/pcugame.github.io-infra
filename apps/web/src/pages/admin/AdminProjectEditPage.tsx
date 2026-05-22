import { useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  UpdateProjectFormSchema,
  type UpdateProjectFormInput,
  AddMemberSchema,
  type AddMemberInput,
} from '../../contracts/schemas';
import type { ProjectStatus, UpdateMemberRequest } from '@pcu/contracts';
import {
  adminProjectApi,
  adminMemberApi,
  adminAssetApi,
  getApiErrorMessage,
  type UploadProgress,
} from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { buildAssetFormData } from '../../lib/utils';
import { LoadingSpinner, ErrorMessage } from '../../components/common';
import { useMe } from '../../features/auth';
import { MemberRow } from '../../features/admin/projects/MemberRow';
import { getClientUploadLimits } from '../../lib/upload-limits';
import GameUploadWidget from '../../components/GameUploadWidget';
import { UploadProgressModal } from '../../components/common';

const STATUS_LABELS: Record<string, string> = {
  DRAFT: '초안',
  PUBLISHED: '공개',
  ARCHIVED: '보관',
};

export default function AdminProjectEditPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = Number(idParam);
  const qc = useQueryClient();
  const { user } = useMe();

  // ── 프로젝트 데이터 로드 ──────────────────────────────────
  const {
    data: project,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.adminProject(id),
    queryFn: () => adminProjectApi.getDetail(id),
    enabled: !isNaN(id),
  });

  // ── 기본 정보 수정 폼 ─────────────────────────────────────
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
  } = useForm<UpdateProjectFormInput>({
    resolver: zodResolver(UpdateProjectFormSchema),
    values: project
      ? {
          title: project.title,
          summary: project.summary ?? '',
          description: project.description ?? '',
          status: project.status,
          sortOrder: project.sortOrder,
        }
      : undefined,
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateProjectFormInput) =>
      adminProjectApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id) });
      qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
      qc.invalidateQueries({ queryKey: queryKeys.publicYears });
    },
  });

  const onSubmitUpdate = (data: UpdateProjectFormInput) => {
    updateMutation.mutate(data);
  };

  // ── 멤버 추가 ─────────────────────────────────────────────
  const [newMember, setNewMember] = useState<AddMemberInput>({
    name: '',
    studentId: '',
  });

  const addMemberMutation = useMutation({
    mutationFn: (body: AddMemberInput) => adminMemberApi.add(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id) });
      setNewMember({ name: '', studentId: '' });
    },
  });

  const updateMemberMutation = useMutation({
    mutationFn: ({ memberId, body }: { memberId: number; body: UpdateMemberRequest }) =>
      adminMemberApi.update(id, memberId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id) });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: number) => adminMemberApi.remove(id, memberId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id) });
    },
  });

  const swapMemberMutation = useMutation({
    mutationFn: ({ memberIdA, memberIdB }: { memberIdA: number; memberIdB: number }) =>
      adminMemberApi.swap(id, memberIdA, memberIdB),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id) });
    },
  });

  const swapMemberOrder = (index: number, direction: -1 | 1) => {
    if (!project) return;
    const members = project.members;
    const other = index + direction;
    if (other < 0 || other >= members.length) return;
    swapMemberMutation.mutate({ memberIdA: members[index].id, memberIdB: members[other].id });
  };

  // ── 자산 추가/삭제 ────────────────────────────────────────
  const limits = getClientUploadLimits(user?.role ?? 'USER');
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [assetFileError, setAssetFileError] = useState<string | null>(null);
  const addAssetMutation = useMutation({
    mutationFn: (fd: FormData) => adminProjectApi.addAsset(id, fd, setUploadProgress),
    onSuccess: () => {
      setUploadProgress((prev) => prev ? { ...prev, percent: 100, loaded: prev.total } : prev);
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id) });
    },
    onSettled: () => {
      setUploadProgress(null);
    },
  });

  const setPosterMutation = useMutation({
    mutationFn: (assetId: number) =>
      adminProjectApi.setPoster(id, { assetId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id) });
      qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
    },
  });

  const removeAssetMutation = useMutation({
    mutationFn: (assetId: number) => adminAssetApi.remove(assetId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id) });
    },
  });

  const handleAddAsset = async (kind: string, file: File) => {
    const fd = buildAssetFormData(kind, file);
    setUploadProgress({ loaded: 0, total: 0, percent: 0 });
    const res = await addAssetMutation.mutateAsync(fd);
    if (kind === 'POSTER') {
      try {
        await setPosterMutation.mutateAsync(res.assetId);
      } catch {
        // setPoster 실패는 기존 에러 표시 체계를 따름
      }
    }
  };

  const handleAddAssetFiles = async (kind: string, files: File[]) => {
    const oversized = files.find((file) => {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const maxMb = kind === 'VIDEO'
        ? limits.videoMaxMb
        : kind === 'POSTER'
          ? (isPdf ? limits.posterPdfMaxMb : limits.posterMaxMb)
          : (isPdf ? limits.imagePdfMaxMb : limits.imageMaxMb);
      return file.size > maxMb * 1024 * 1024;
    });
    if (oversized) {
      const isPdf = oversized.type === 'application/pdf' || oversized.name.toLowerCase().endsWith('.pdf');
      const maxMb = kind === 'VIDEO'
        ? limits.videoMaxMb
        : kind === 'POSTER'
          ? (isPdf ? limits.posterPdfMaxMb : limits.posterMaxMb)
          : (isPdf ? limits.imagePdfMaxMb : limits.imageMaxMb);
      setAssetFileError(`${oversized.name}: ${(oversized.size / 1024 / 1024).toFixed(1)}MB — 최대 ${maxMb}MB까지 허용됩니다.`);
      return;
    }
    setAssetFileError(null);
    for (const file of files) {
      await handleAddAsset(kind, file);
    }
  };

  // ── 상태 토글 (publish/archive) ───────────────────────────
  const isPrivileged = user?.role === 'OPERATOR' || user?.role === 'ADMIN';

  const toggleStatusMutation = useMutation({
    mutationFn: (status: ProjectStatus) =>
      adminProjectApi.update(id, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id) });
      qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
      qc.invalidateQueries({ queryKey: queryKeys.publicYears });
    },
  });

  // ── 렌더링 ────────────────────────────────────────────────
  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;
  if (!project) return null;

  // USER can only edit DRAFT projects; OPERATOR/ADMIN can edit any status
  const canEditContent = isPrivileged || project.status === 'DRAFT';

  return (
    <div className="admin-project-edit-page">
      <UploadProgressModal
        open={addAssetMutation.isPending}
        title="자산 업로드"
        percent={uploadProgress?.percent}
        loadedBytes={uploadProgress?.loaded}
        totalBytes={uploadProgress?.total}
        status="파일 전송 및 변환이 끝날 때까지 이 창을 닫거나 새로고침하지 마세요."
      />

      <div className="admin-page-header">
        <div className="admin-page-header__text">
          <h1>
            작품 수정
            {project.isIncomplete && <span className="incomplete-badge">불완전</span>}
          </h1>
        </div>
      </div>
      <p className="edit-meta">
        슬러그: <code>{project.slug}</code> | 연도: <span className="admin-year-badge">{project.year}</span>
        {project.isIncomplete && ' | 불완전 자료'}
      </p>

      {/* ── 기본 정보 폼 ────────────────────────────────────── */}
      <form onSubmit={handleSubmit(onSubmitUpdate)} className="project-form">
        <fieldset>
          <legend>기본 정보</legend>

          <div className="form-field">
            <label htmlFor="title">제목 *</label>
            <input id="title" type="text" {...register('title')} />
            {errors.title && <span className="field-error">{errors.title.message}</span>}
          </div>

          <div className="form-field">
            <label htmlFor="summary">한줄 소개</label>
            <input id="summary" type="text" {...register('summary')} />
          </div>

          <div className="form-field">
            <label htmlFor="description">상세 설명</label>
            <textarea id="description" rows={6} {...register('description')} />
          </div>

          <div className="form-field">
            <label htmlFor="sortOrder">정렬 순서</label>
            <input
              id="sortOrder"
              type="number"
              {...register('sortOrder', { valueAsNumber: true })}
            />
          </div>

        </fieldset>

        {updateMutation.error && (
          <div className="error-box" role="alert">
            <p>{getApiErrorMessage(updateMutation.error)}</p>
          </div>
        )}
        {updateMutation.isSuccess && (
          <p className="success-message">저장되었습니다.</p>
        )}

        <div className="form-actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!isDirty || updateMutation.isPending}
          >
            {updateMutation.isPending ? '저장 중…' : '변경사항 저장'}
          </button>
        </div>
      </form>

      {/* ── 공개 상태 ───────────────────────────────────────── */}
      <div className="project-form">
      <fieldset className="status-section">
        <legend>공개 상태</legend>
        <p>
          현재 상태:{' '}
          <strong>{STATUS_LABELS[project.status]}</strong>
        </p>
        <div className="form-actions">
          {project.status !== 'PUBLISHED' && (
            <button
              className="btn btn--primary btn--small"
              onClick={() => toggleStatusMutation.mutate('PUBLISHED')}
              disabled={toggleStatusMutation.isPending}
            >
              공개로 전환
            </button>
          )}
          {project.status !== 'DRAFT' && (
            <button
              className="btn btn--secondary btn--small"
              onClick={() => toggleStatusMutation.mutate('DRAFT')}
              disabled={toggleStatusMutation.isPending}
            >
              초안으로 전환
            </button>
          )}
          {project.status !== 'ARCHIVED' && isPrivileged && (
            <button
              className="btn btn--danger btn--small"
              onClick={() => toggleStatusMutation.mutate('ARCHIVED')}
              disabled={toggleStatusMutation.isPending}
            >
              보관
            </button>
          )}
        </div>
        {toggleStatusMutation.error && (
          <p className="field-error">{getApiErrorMessage(toggleStatusMutation.error)}</p>
        )}
      </fieldset>

      {/* ── 참여 학생 ───────────────────────────────────────── */}
      <fieldset>
        <legend>참여 학생</legend>
        {!canEditContent && (
          <p className="field-hint">초안 상태에서만 멤버를 수정할 수 있습니다.</p>
        )}
        <ul className="member-list">
          {project.members.map((m, idx) => (
            <MemberRow
              key={m.id}
              member={m}
              index={idx}
              total={project.members.length}
              onSwap={swapMemberOrder}
              onUpdate={(body) =>
                updateMemberMutation.mutate({ memberId: m.id, body })
              }
              onRemove={() => removeMemberMutation.mutate(m.id)}
              isBusy={
                updateMemberMutation.isPending || removeMemberMutation.isPending || swapMemberMutation.isPending
              }
              disabled={!canEditContent}
            />
          ))}
        </ul>

        {canEditContent && (
          <div className="member-add-row">
            <input
              type="text"
              placeholder="이름"
              value={newMember.name}
              onChange={(e) =>
                setNewMember((prev) => ({ ...prev, name: e.target.value }))
              }
            />
            <input
              type="text"
              placeholder="학번"
              value={newMember.studentId}
              onChange={(e) =>
                setNewMember((prev) => ({ ...prev, studentId: e.target.value }))
              }
            />
            <button
              className="btn btn--secondary btn--small"
              onClick={() => {
                const parsed = AddMemberSchema.safeParse(newMember);
                if (parsed.success) {
                  addMemberMutation.mutate(parsed.data);
                }
              }}
              disabled={addMemberMutation.isPending}
            >
              추가
            </button>
          </div>
        )}
      </fieldset>

      {/* ── 자산 관리 ───────────────────────────────────────── */}
      <fieldset>
        <legend>등록된 자산</legend>
        {!canEditContent && (
          <p className="field-hint">초안 상태에서만 자산을 수정할 수 있습니다.</p>
        )}

        {project.posterAssetId && (
          <p className="asset-current-poster">
            현재 포스터:{' '}
            <strong>
              {project.assets.find((a) => a.id === project.posterAssetId)
                ?.originalName ?? project.posterAssetId}
            </strong>
          </p>
        )}

        {project.assets.length === 0 ? (
          <p>등록된 자산이 없습니다.</p>
        ) : (
          <ul className="asset-list">
            {project.assets.map((asset) => {
              const isCurrentPoster = asset.id === project.posterAssetId;
              const canSetAsPoster =
                canEditContent &&
                (asset.kind === 'IMAGE' || asset.kind === 'POSTER') &&
                !isCurrentPoster;
              return (
                <li key={asset.id} className="asset-list__item">
                  <span>
                    [{asset.kind}] {asset.originalName} (
                    {(asset.size / 1024).toFixed(0)}KB)
                    {isCurrentPoster && (
                      <strong className="asset-poster-label">
                        [포스터]
                      </strong>
                    )}
                  </span>
                  {asset.kind === 'VIDEO' && asset.playbackStatus && (
                    <p className="field-hint">
                      재생용: {asset.playbackStatus}
                      {asset.playbackError ? ` (${asset.playbackError})` : ''}
                    </p>
                  )}
                  {asset.kind === 'IMAGE' || asset.kind === 'POSTER' ? (
                    <img
                      src={asset.url}
                      alt={asset.originalName}
                      className="asset-thumb"
                      loading="lazy"
                    />
                  ) : null}
                  {canEditContent && (
                    <div className="asset-actions">
                      {canSetAsPoster && (
                        <button
                          className="btn btn--secondary btn--small"
                          onClick={() => setPosterMutation.mutate(asset.id)}
                          disabled={setPosterMutation.isPending}
                        >
                          포스터로 지정
                        </button>
                      )}
                      {asset.kind === 'VIDEO' && asset.originalDownloadUrl && (
                        <a
                          className="btn btn--secondary btn--small"
                          href={asset.originalDownloadUrl}
                          download
                        >
                          원본 다운로드
                        </a>
                      )}
                      <button
                        className="btn btn--danger btn--small"
                        onClick={() => removeAssetMutation.mutate(asset.id)}
                        disabled={removeAssetMutation.isPending}
                      >
                        삭제
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canEditContent && (
          <>
            <div className="asset-upload-section">
              <h4>자산 추가</h4>
              {([
                { label: `포스터 교체 (JPG · PNG · WebP 최대 ${limits.posterMaxMb}MB / PDF 최대 ${limits.posterPdfMaxMb}MB, PDF는 첫 페이지를 WEBP로 자동 변환)`, kind: 'POSTER', accept: 'image/jpeg,image/png,image/webp,application/pdf,.pdf' },
                { label: `동영상 업로드 (MP4 · MKV · WebM · AVI · WMV, 자동 MP4 변환, 최대 ${limits.videoMaxMb}MB)`, kind: 'VIDEO', accept: 'video/mp4,video/x-matroska,video/webm,video/x-msvideo,video/x-ms-wmv,.mp4,.mkv,.webm,.avi,.wmv' },
                { label: `이미지 추가 (JPG · PNG · WebP 최대 ${limits.imageMaxMb}MB / PDF 최대 ${limits.imagePdfMaxMb}MB, PDF는 첫 페이지를 WEBP로 자동 변환)`, kind: 'IMAGE', accept: 'image/jpeg,image/png,image/webp,application/pdf,.pdf' },
              ] as const).map(({ label, kind, accept }) => (
                <div key={kind} className="form-field">
                  <label>{label}</label>
                  <input
                    type="file"
                    accept={accept}
                    multiple={kind === 'VIDEO'}
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = '';
                      if (files.length > 0) {
                        void handleAddAssetFiles(kind, kind === 'VIDEO' ? files : files.slice(0, 1)).catch(() => {});
                      }
                    }}
                  />
                </div>
              ))}
              {addAssetMutation.error && (
                <p className="field-error">{getApiErrorMessage(addAssetMutation.error)}</p>
              )}
              {assetFileError && (
                <p className="field-error">{assetFileError}</p>
              )}
            </div>

            {/* ── 대용량 게임 파일 (청크 업로드) ──────────────── */}
            <GameUploadWidget projectId={id} />
          </>
        )}
      </fieldset>
      </div>
    </div>
  );
}
