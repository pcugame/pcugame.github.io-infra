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
import type { ProjectStatus } from '../../contracts';
import {
  adminProjectApi,
  adminMemberApi,
  adminAssetApi,
  getApiErrorMessage,
} from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { buildAssetFormData } from '../../lib/utils';
import { LoadingSpinner, ErrorMessage } from '../../components/common';
import { useMe } from '../../features/auth';

export default function AdminProjectEditPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { user } = useMe();

  // ── 프로젝트 데이터 로드 ──────────────────────────────────
  const {
    data: project,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.adminProject(id!),
    queryFn: () => adminProjectApi.getDetail(id!),
    enabled: !!id,
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
          youtubeUrl: project.youtubeUrl ?? '',
          status: project.status,
          sortOrder: project.sortOrder,
          downloadPolicy: project.downloadPolicy,
        }
      : undefined,
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateProjectFormInput) =>
      adminProjectApi.update(id!, {
        ...data,
        youtubeUrl: data.youtubeUrl || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id!) });
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
    mutationFn: (body: AddMemberInput) => adminMemberApi.add(id!, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id!) });
      setNewMember({ name: '', studentId: '' });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) => adminMemberApi.remove(id!, memberId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id!) });
    },
  });

  // ── 자산 추가/삭제 ────────────────────────────────────────
  const addAssetMutation = useMutation({
    mutationFn: (fd: FormData) => adminProjectApi.addAsset(id!, fd),
  });

  const setPosterMutation = useMutation({
    mutationFn: (assetId: string) =>
      adminProjectApi.setPoster(id!, { assetId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id!) });
      qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
    },
  });

  const removeAssetMutation = useMutation({
    mutationFn: (assetId: string) => adminAssetApi.remove(assetId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id!) });
    },
  });

  const handleAddAsset = (kind: string, file: File) => {
    const fd = buildAssetFormData(kind, file);
    addAssetMutation.mutate(fd, {
      onSuccess: async (res) => {
        if (kind === 'POSTER') {
          try {
            await setPosterMutation.mutateAsync(res.assetId);
          } catch {
            // setPoster 실패는 기존 에러 표시 체계를 따름
          }
        } else {
          qc.invalidateQueries({ queryKey: queryKeys.adminProject(id!) });
        }
      },
    });
  };

  // ── 상태 토글 (publish/archive) ───────────────────────────
  const canChangeStatus =
    user?.role === 'OPERATOR' || user?.role === 'ADMIN';

  const toggleStatusMutation = useMutation({
    mutationFn: (status: ProjectStatus) =>
      adminProjectApi.update(id!, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProject(id!) });
      qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
      qc.invalidateQueries({ queryKey: queryKeys.publicYears });
    },
  });

  // ── 렌더링 ────────────────────────────────────────────────
  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;
  if (!project) return null;

  return (
    <div className="admin-project-edit-page">
      <h1>작품 수정: {project.title}</h1>
      <p className="edit-meta">
        슬러그: <code>{project.slug}</code> | 연도: {project.year}
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
            <label htmlFor="youtubeUrl">YouTube URL</label>
            <input id="youtubeUrl" type="url" {...register('youtubeUrl')} />
          </div>

          <div className="form-field">
            <label htmlFor="sortOrder">정렬 순서</label>
            <input
              id="sortOrder"
              type="number"
              {...register('sortOrder', { valueAsNumber: true })}
            />
          </div>

          <div className="form-field">
            <label htmlFor="downloadPolicy">다운로드 정책</label>
            <select id="downloadPolicy" {...register('downloadPolicy')}>
              <option value="PUBLIC">공개</option>
              <option value="SCHOOL_ONLY">학교 계정만</option>
              <option value="ADMIN_ONLY">관리자만</option>
              <option value="NONE">비공개</option>
            </select>
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
      {canChangeStatus && (
        <fieldset className="status-section">
          <legend>공개 상태</legend>
          <p>
            현재 상태:{' '}
            <strong>
              {project.status === 'DRAFT'
                ? '초안'
                : project.status === 'PUBLISHED'
                  ? '공개'
                  : '보관'}
            </strong>
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
            {project.status !== 'ARCHIVED' && (
              <button
                className="btn btn--danger btn--small"
                onClick={() => toggleStatusMutation.mutate('ARCHIVED')}
                disabled={toggleStatusMutation.isPending}
              >
                보관
              </button>
            )}
          </div>
        </fieldset>
      )}

      {/* ── 참여 학생 ───────────────────────────────────────── */}
      <fieldset>
        <legend>참여 학생</legend>
        <ul className="member-list">
          {project.members.map((m) => (
            <li key={m.id} className="member-list__item">
              <span>
                {m.name} ({m.studentId})
              </span>
              <button
                className="btn btn--danger btn--small"
                onClick={() => removeMemberMutation.mutate(m.id)}
                disabled={removeMemberMutation.isPending}
              >
                삭제
              </button>
            </li>
          ))}
        </ul>

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
      </fieldset>

      {/* ── 자산 관리 ───────────────────────────────────────── */}
      <fieldset>
        <legend>등록된 자산</legend>

        {project.assets.length === 0 ? (
          <p>등록된 자산이 없습니다.</p>
        ) : (
          <ul className="asset-list">
            {project.assets.map((asset) => (
              <li key={asset.id} className="asset-list__item">
                <span>
                  [{asset.kind}] {asset.originalName} (
                  {(asset.size / 1024).toFixed(0)}KB)
                </span>
                {asset.kind === 'IMAGE' || asset.kind === 'POSTER' ? (
                  <img
                    src={asset.url}
                    alt={asset.originalName}
                    className="asset-thumb"
                    loading="lazy"
                  />
                ) : null}
                <button
                  className="btn btn--danger btn--small"
                  onClick={() => removeAssetMutation.mutate(asset.id)}
                  disabled={removeAssetMutation.isPending}
                >
                  삭제
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="asset-upload-section">
          <h4>자산 추가</h4>
          <div className="form-field">
            <label>이미지 추가</label>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAddAsset('IMAGE', f);
                e.target.value = '';
              }}
            />
          </div>
          <div className="form-field">
            <label>포스터 교체</label>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAddAsset('POSTER', f);
                e.target.value = '';
              }}
            />
          </div>
          <div className="form-field">
            <label>게임 파일 (ZIP)</label>
            <input
              type="file"
              accept=".zip"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAddAsset('GAME', f);
                e.target.value = '';
              }}
            />
          </div>
          {addAssetMutation.error && (
            <p className="field-error">{getApiErrorMessage(addAssetMutation.error)}</p>
          )}
        </div>
      </fieldset>
    </div>
  );
}
