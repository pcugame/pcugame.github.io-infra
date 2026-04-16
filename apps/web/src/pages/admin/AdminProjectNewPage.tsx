import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm, useFieldArray, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SubmitProjectPayloadSchema,
  type SubmitProjectPayloadInput,
} from '../../contracts/schemas';
import { adminProjectApi, adminExhibitionApi, getApiErrorMessage } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { buildSubmitFormData } from '../../lib/utils';
import { useMe } from '../../features/auth';
import { getClientUploadLimits } from '../../lib/upload-limits';
import GameUploadWidget from '../../components/GameUploadWidget';

export default function AdminProjectNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useMe();
  const isPrivileged = user?.role === 'ADMIN' || user?.role === 'OPERATOR';
  const limits = getClientUploadLimits(user?.role ?? 'USER');

  // ── 전시회 목록 (업로드 잠금 여부 표시) ──────────────────────
  const { data: yearsData } = useQuery({
    queryKey: queryKeys.adminExhibitions,
    queryFn: adminExhibitionApi.list,
  });
  const years = yearsData?.items ?? [];

  // ── 폼 ──────────────────────────────────────────────────────
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<SubmitProjectPayloadInput>({
    resolver: zodResolver(SubmitProjectPayloadSchema),
    defaultValues: {
      exhibitionId: 0, // sentinel: Zod .positive() rejects 0 → "전시회를 선택하세요"
      title: '',
      summary: '',
      description: '',
      autoPublish: false,
      members: [{ name: '', studentId: '' }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'members',
  });

  const selectedExhibitionId = useWatch({ control, name: 'exhibitionId' });
  const selectedYearItem = years.find((y) => y.id === Number(selectedExhibitionId));
  const isUploadLocked = selectedYearItem != null && !selectedYearItem.isUploadEnabled && !isPrivileged;

  // ── 파일 상태 ──────────────────────────────────────────────
  const [posterFile, setPosterFile] = useState<File | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [gameFile, setGameFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [posterPreview, setPosterPreview] = useState<string | null>(null);
  const [fileSizeError, setFileSizeError] = useState<string | null>(null);
  const posterPreviewRef = useRef<string | null>(null);

  // ── 게임 청크 업로드 (프로젝트 생성 후) ────────────────────
  const [createdProjectId, setCreatedProjectId] = useState<number | null>(null);

  // Cleanup poster ObjectURL on unmount
  useEffect(() => {
    return () => {
      if (posterPreviewRef.current) URL.revokeObjectURL(posterPreviewRef.current);
    };
  }, []);

  /** Validate file size against the role-based limit for the given kind. */
  const checkFileSize = (file: File, maxMb: number, label: string): boolean => {
    if (file.size > maxMb * 1024 * 1024) {
      setFileSizeError(`${label}: ${(file.size / 1024 / 1024).toFixed(1)}MB — 최대 ${maxMb}MB까지 허용됩니다.`);
      return false;
    }
    setFileSizeError(null);
    return true;
  };

  const handlePosterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    // Revoke previous ObjectURL
    if (posterPreviewRef.current) {
      URL.revokeObjectURL(posterPreviewRef.current);
      posterPreviewRef.current = null;
    }
    if (file && !checkFileSize(file, limits.posterMaxMb, '포스터')) {
      setPosterFile(null);
      setPosterPreview(null);
      e.target.value = '';
      return;
    }
    setPosterFile(file);
    if (file) {
      const url = URL.createObjectURL(file);
      posterPreviewRef.current = url;
      setPosterPreview(url);
    } else {
      setPosterPreview(null);
    }
  };

  const handleImagesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const oversized = files.find((f) => f.size > limits.imageMaxMb * 1024 * 1024);
    if (oversized) {
      setFileSizeError(`이미지 "${oversized.name}": ${(oversized.size / 1024 / 1024).toFixed(1)}MB — 최대 ${limits.imageMaxMb}MB까지 허용됩니다.`);
      setImageFiles([]);
      e.target.value = '';
      return;
    }
    setFileSizeError(null);
    setImageFiles(files);
  };

  const handleGameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    // 게임 파일은 청크 업로드이므로 서버 최대(5GB) 기준으로 느슨하게 체크
    if (file && file.size > 5 * 1024 * 1024 * 1024) {
      setFileSizeError(`게임 파일: ${(file.size / 1024 / 1024).toFixed(1)}MB — 최대 5120MB까지 허용됩니다.`);
      setGameFile(null);
      e.target.value = '';
      return;
    }
    setFileSizeError(null);
    setGameFile(file);
  };

  const handleVideoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (file && !checkFileSize(file, limits.videoMaxMb, '동영상')) {
      setVideoFile(null);
      e.target.value = '';
      return;
    }
    setVideoFile(file);
  };

  // ── 제출 ───────────────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: (formData: FormData) => adminProjectApi.submit(formData),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
      qc.invalidateQueries({ queryKey: queryKeys.publicYears });
      qc.invalidateQueries({ queryKey: queryKeys.yearProjects(res.year) });

      if (gameFile) {
        // 게임 파일이 있으면 같은 화면에서 GameUploadWidget으로 청크 업로드
        setCreatedProjectId(res.id);
      } else {
        navigate(`/admin/projects/${res.id}/edit`);
      }
    },
  });

  const onSubmit = (data: SubmitProjectPayloadInput) => {
    // Auto-link the first member matching creator's name with their userId
    if (user) {
      const creatorMember = data.members.find((m) => m.name === user.name);
      if (creatorMember) creatorMember.userId = user.id;
    }
    // 게임 파일은 청크 업로드로 별도 전송하므로 FormData에서 제외
    const fd = buildSubmitFormData(data, {
      poster: posterFile ?? undefined,
      images: imageFiles.length > 0 ? imageFiles : undefined,
      videoFile: videoFile ?? undefined,
    });
    submitMutation.mutate(fd);
  };

  const goToEdit = () => {
    if (!createdProjectId) return;
    navigate(`/admin/projects/${createdProjectId}/edit`);
  };

  const isSubmitting = submitMutation.isPending;
  const showGameProgress = createdProjectId !== null;

  return (
    <div className="admin-project-new-page">
      <div className="admin-page-header">
        <div className="admin-page-header__text">
          <span className="admin-page-header__eyebrow">New Project</span>
          <h1>새 작품 등록</h1>
        </div>
      </div>

      {/* ── 게임 업로드 진행 화면 (프로젝트 생성 완료 후) ──── */}
      {showGameProgress && (
        <GameUploadWidget
          projectId={createdProjectId!}
          initialFile={gameFile}
          autoStart
          onComplete={goToEdit}
          onSkip={goToEdit}
        />
      )}

      {/* ── 등록 폼 (프로젝트 미생성 상태에서만 표시) ────────── */}
      {!showGameProgress && (
      <form onSubmit={handleSubmit(onSubmit)} className="project-form">
        {/* ── 기본 정보 ──────────────────────────────────────── */}
        <fieldset>
          <legend>기본 정보</legend>

          <div className="form-field">
            <label htmlFor="exhibitionId">전시회 *</label>
            {years.length > 0 ? (
              <select id="exhibitionId" {...register('exhibitionId', { valueAsNumber: true })}>
                <option value={0}>전시회를 선택하세요</option>
                {years.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.year}{y.title ? ` — ${y.title}` : ''}
                    {!y.isUploadEnabled ? ' (업로드 잠김)' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <p className="field-error">등록된 전시회가 없습니다. 관리자에게 문의하세요.</p>
            )}
            {errors.exhibitionId && <span className="field-error">{errors.exhibitionId.message}</span>}
            {isUploadLocked && (
              <span className="field-error">
                이 전시회는 업로드가 잠겨 있습니다. 운영자에게 문의하세요.
              </span>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="title">제목 *</label>
            <input id="title" type="text" {...register('title')} />
            {errors.title && <span className="field-error">{errors.title.message}</span>}
          </div>

          <div className="form-field">
            <label htmlFor="summary">한줄 소개</label>
            <input id="summary" type="text" {...register('summary')} />
            {errors.summary && <span className="field-error">{errors.summary.message}</span>}
          </div>

          <div className="form-field">
            <label htmlFor="description">상세 설명</label>
            <textarea id="description" rows={6} {...register('description')} />
            {errors.description && (
              <span className="field-error">{errors.description.message}</span>
            )}
          </div>

          <div className="form-field form-field--checkbox">
            <label>
              <input type="checkbox" {...register('autoPublish')} />
              즉시 공개
            </label>
          </div>
        </fieldset>

        {/* ── 참여 학생 ──────────────────────────────────────── */}
        <fieldset>
          <legend>참여 학생 *</legend>
          {errors.members?.root && (
            <span className="field-error">{errors.members.root.message}</span>
          )}
          {errors.members?.message && (
            <span className="field-error">{errors.members.message}</span>
          )}

          {fields.map((field, index) => (
            <div key={field.id} className="member-row">
              <div className="form-field">
                <label htmlFor={`members.${index}.name`}>이름</label>
                <input
                  id={`members.${index}.name`}
                  type="text"
                  {...register(`members.${index}.name`)}
                />
                {errors.members?.[index]?.name && (
                  <span className="field-error">
                    {errors.members[index].name?.message}
                  </span>
                )}
              </div>

              <div className="form-field">
                <label htmlFor={`members.${index}.studentId`}>학번</label>
                <input
                  id={`members.${index}.studentId`}
                  type="text"
                  {...register(`members.${index}.studentId`)}
                />
                {errors.members?.[index]?.studentId && (
                  <span className="field-error">
                    {errors.members[index].studentId?.message}
                  </span>
                )}
              </div>

              {fields.length > 1 && (
                <button
                  type="button"
                  className="btn btn--danger btn--small"
                  onClick={() => remove(index)}
                >
                  삭제
                </button>
              )}
            </div>
          ))}

          <button
            type="button"
            className="btn btn--secondary btn--small"
            onClick={() => append({ name: '', studentId: '' })}
          >
            학생 추가
          </button>
        </fieldset>

        {/* ── 파일 업로드 ────────────────────────────────────── */}
        <fieldset>
          <legend>파일 업로드</legend>

          {fileSizeError && (
            <div className="error-box" role="alert">
              <p>{fileSizeError}</p>
            </div>
          )}

          <div className="form-field">
            <label htmlFor="poster">포스터 이미지 (최대 {limits.posterMaxMb}MB)</label>
            <input
              id="poster"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handlePosterChange}
            />
            {posterPreview && (
              <div className="poster-preview">
                <img src={posterPreview} alt="포스터 미리보기" />
              </div>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="images">추가 이미지 (복수 선택 가능, 각 최대 {limits.imageMaxMb}MB)</label>
            <input
              id="images"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={handleImagesChange}
            />
            {imageFiles.length > 0 && (
              <p className="file-info">{imageFiles.length}개 파일 선택됨</p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="videoFile">동영상 (MP4, WebM, 최대 {limits.videoMaxMb}MB)</label>
            <input
              id="videoFile"
              type="file"
              accept="video/mp4,video/webm,.mp4,.webm"
              onChange={handleVideoChange}
            />
            {videoFile && (
              <p className="file-info">
                {videoFile.name} ({(videoFile.size / 1024 / 1024).toFixed(1)}MB)
              </p>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="gameFile">게임 파일 (ZIP, 최대 5GB)</label>
            <input
              id="gameFile"
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              onChange={handleGameChange}
            />
            {gameFile && (
              <p className="file-info">
                {gameFile.name} ({(gameFile.size / 1024 / 1024).toFixed(1)}MB)
              </p>
            )}
            <p className="field-hint">
              작품 등록 후 자동으로 청크 업로드가 시작됩니다. 중간에 끊겨도 이어서 올릴 수 있습니다.
            </p>
          </div>
        </fieldset>

        {/* ── 제출 ───────────────────────────────────────────── */}
        {submitMutation.error && (
          <div className="error-box" role="alert">
            <p>{getApiErrorMessage(submitMutation.error)}</p>
          </div>
        )}

        <div className="form-actions">
          <button
            type="submit"
            className="btn btn--primary btn--large"
            disabled={isSubmitting || isUploadLocked}
          >
            {isSubmitting ? '등록 중…' : '작품 등록'}
          </button>
        </div>
      </form>
      )}
    </div>
  );
}
