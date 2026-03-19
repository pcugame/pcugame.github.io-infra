import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SubmitProjectPayloadSchema,
  type SubmitProjectPayloadInput,
} from '../../contracts/schemas';
import { adminProjectApi, getApiErrorMessage } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { buildSubmitFormData } from '../../lib/utils';

export default function AdminProjectNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  // ── 폼 ──────────────────────────────────────────────────────
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<SubmitProjectPayloadInput>({
    resolver: zodResolver(SubmitProjectPayloadSchema),
    defaultValues: {
      year: new Date().getFullYear(),
      title: '',
      summary: '',
      description: '',
      youtubeUrl: '',
      autoPublish: false,
      members: [{ name: '', studentId: '' }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'members',
  });

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
      <h1>새 작품 등록</h1>

      <form onSubmit={handleSubmit(onSubmit)} className="project-form">
        {/* ── 기본 정보 ──────────────────────────────────────── */}
        <fieldset>
          <legend>기본 정보</legend>

          <div className="form-field">
            <label htmlFor="year">연도 *</label>
            <input
              id="year"
              type="number"
              {...register('year', { valueAsNumber: true })}
            />
            {errors.year && <span className="field-error">{errors.year.message}</span>}
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
            <label htmlFor="youtubeUrl">YouTube URL</label>
            <input
              id="youtubeUrl"
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              {...register('youtubeUrl')}
            />
            {errors.youtubeUrl && (
              <span className="field-error">{errors.youtubeUrl.message}</span>
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
            disabled={submitMutation.isPending}
          >
            {submitMutation.isPending ? '등록 중…' : '작품 등록'}
          </button>
        </div>
      </form>
    </div>
  );
}
