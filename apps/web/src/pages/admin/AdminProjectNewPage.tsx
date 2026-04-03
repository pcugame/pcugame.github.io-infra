import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SubmitProjectPayloadSchema,
  type SubmitProjectPayloadInput,
} from '../../contracts/schemas';
import { adminProjectApi, adminYearApi, getApiErrorMessage } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { buildSubmitFormData } from '../../lib/utils';
import { useMe } from '../../features/auth';

export default function AdminProjectNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useMe();
  const isPrivileged = user?.role === 'ADMIN' || user?.role === 'OPERATOR';

  // ── 연도 목록 (업로드 잠금 여부 표시) ──────────────────────
  const { data: yearsData } = useQuery({
    queryKey: queryKeys.adminYears,
    queryFn: adminYearApi.list,
  });
  const years = yearsData?.items ?? [];

  // ── 폼 ──────────────────────────────────────────────────────
  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<SubmitProjectPayloadInput>({
    resolver: zodResolver(SubmitProjectPayloadSchema),
    defaultValues: {
      year: new Date().getFullYear(),
      title: '',
      summary: '',
      description: '',
      videoUrl: '',
      videoMimeType: '',
      autoPublish: false,
      members: [{ name: '', studentId: '' }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'members',
  });

  const selectedYear = watch('year');
  const selectedYearItem = years.find((y) => y.year === selectedYear);
  const isUploadLocked = selectedYearItem != null && !selectedYearItem.isUploadEnabled && !isPrivileged;

  // ── 파일 상태 ──────────────────────────────────────────────
  const [posterFile, setPosterFile] = useState<File | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [gameFile, setGameFile] = useState<File | null>(null);
  const [posterPreview, setPosterPreview] = useState<string | null>(null);

  const handlePosterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setPosterFile(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setPosterPreview(url);
    } else {
      setPosterPreview(null);
    }
  };

  const handleImagesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setImageFiles(Array.from(e.target.files ?? []));
  };

  const handleGameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setGameFile(e.target.files?.[0] ?? null);
  };

  // ── 제출 ───────────────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: (formData: FormData) => adminProjectApi.submit(formData),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
      qc.invalidateQueries({ queryKey: queryKeys.publicYears });
      qc.invalidateQueries({ queryKey: queryKeys.yearProjects(res.year) });
      navigate(`/admin/projects/${res.id}/edit`);
    },
  });

  const onSubmit = (data: SubmitProjectPayloadInput) => {
    const fd = buildSubmitFormData(data, {
      poster: posterFile ?? undefined,
      images: imageFiles.length > 0 ? imageFiles : undefined,
      gameFile: gameFile ?? undefined,
    });
    submitMutation.mutate(fd);
  };

  return (
    <div className="admin-project-new-page">
      <div className="admin-page-header">
        <div className="admin-page-header__text">
          <span className="admin-page-header__eyebrow">New Project</span>
          <h1>새 작품 등록</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="project-form">
        {/* ── 기본 정보 ──────────────────────────────────────── */}
        <fieldset>
          <legend>기본 정보</legend>

          <div className="form-field">
            <label htmlFor="year">연도 *</label>
            {years.length > 0 ? (
              <select
                id="year"
                {...register('year', { valueAsNumber: true })}
              >
                {years.map((y) => (
                  <option key={y.id} value={y.year}>
                    {y.year}{y.title ? ` — ${y.title}` : ''}
                    {!y.isUploadEnabled ? ' (업로드 잠김)' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="year"
                type="number"
                {...register('year', { valueAsNumber: true })}
              />
            )}
            {errors.year && <span className="field-error">{errors.year.message}</span>}
            {isUploadLocked && (
              <span className="field-error">
                이 연도는 업로드가 잠겨 있습니다. 운영자에게 문의하세요.
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

          <div className="form-field">
            <label htmlFor="videoUrl">영상 URL (NAS)</label>
            <input
              id="videoUrl"
              type="url"
              placeholder="https://nas.example.com/video/game-trailer.mp4"
              {...register('videoUrl')}
            />
            {errors.videoUrl && (
              <span className="field-error">{errors.videoUrl.message}</span>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="videoMimeType">영상 MIME 타입</label>
            <select id="videoMimeType" {...register('videoMimeType')}>
              <option value="">선택 안 함</option>
              <option value="video/mp4">video/mp4</option>
              <option value="video/webm">video/webm</option>
              <option value="video/ogg">video/ogg</option>
            </select>
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

          <div className="form-field">
            <label htmlFor="poster">포스터 이미지</label>
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
            <label htmlFor="images">추가 이미지 (복수 선택 가능)</label>
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
            <label htmlFor="gameFile">게임 파일 (ZIP)</label>
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
            disabled={submitMutation.isPending || isUploadLocked}
          >
            {submitMutation.isPending ? '등록 중…' : '작품 등록'}
          </button>
        </div>
      </form>
    </div>
  );
}
