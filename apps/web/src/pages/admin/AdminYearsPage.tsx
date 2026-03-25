import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CreateYearSchema,
  UpdateYearSchema,
  type CreateYearInput,
  type UpdateYearInput,
} from '../../contracts/schemas';
import type { AdminYearItem } from '../../contracts';
import { adminYearApi, getApiErrorMessage } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../../components/common';

export default function AdminYearsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.adminYears,
    queryFn: adminYearApi.list,
  });

  // ── 연도 생성 ─────────────────────────────────────────────
  const {
    register: regCreate,
    handleSubmit: handleCreate,
    formState: { errors: createErrors },
    reset: resetCreate,
  } = useForm<CreateYearInput>({
    resolver: zodResolver(CreateYearSchema),
    defaultValues: {
      year: new Date().getFullYear(),
      title: '',
      isOpen: true,
      sortOrder: 0,
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateYearInput) =>
      adminYearApi.create({
        year: data.year,
        title: data.title || undefined,
        isOpen: data.isOpen,
        sortOrder: data.sortOrder,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminYears });
      qc.invalidateQueries({ queryKey: queryKeys.publicYears });
      resetCreate();
    },
  });

  // ── 연도 수정 (인라인) ────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;

  const years = data?.items ?? [];

  return (
    <div className="admin-years-page">
      <h1>연도 관리</h1>

      {/* ── 새 연도 생성 ────────────────────────────────────── */}
      <form
        onSubmit={handleCreate((d) => createMutation.mutate(d))}
        className="year-create-form"
      >
        <h3>새 연도 추가</h3>
        <div className="form-row">
          <div className="form-field">
            <label htmlFor="new-year">연도 *</label>
            <input
              id="new-year"
              type="number"
              {...regCreate('year', { valueAsNumber: true })}
            />
            {createErrors.year && (
              <span className="field-error">{createErrors.year.message}</span>
            )}
          </div>
          <div className="form-field">
            <label htmlFor="new-title">제목</label>
            <input id="new-title" type="text" {...regCreate('title')} />
          </div>
          <div className="form-field form-field--checkbox">
            <label>
              <input type="checkbox" {...regCreate('isOpen')} />
              업로드 허용
            </label>
          </div>
          <div className="form-field">
            <label htmlFor="new-sort">정렬</label>
            <input
              id="new-sort"
              type="number"
              {...regCreate('sortOrder', { valueAsNumber: true })}
              style={{ width: '80px' }}
            />
          </div>
          <button
            type="submit"
            className="btn btn--primary btn--small"
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? '추가 중…' : '추가'}
          </button>
        </div>
        {createMutation.error && (
          <p className="field-error">{getApiErrorMessage(createMutation.error)}</p>
        )}
      </form>

      {/* ── 연도 목록 ───────────────────────────────────────── */}
      {years.length === 0 ? (
        <EmptyState message="등록된 연도가 없습니다." />
      ) : (
        <table className="admin-table">
          <thead>
            <tr>
              <th>연도</th>
              <th>제목</th>
              <th>업로드</th>
              <th>정렬</th>
              <th>작품 수</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <YearRow
                key={y.id}
                year={y}
                isEditing={editingId === y.id}
                onEdit={() => setEditingId(y.id)}
                onCancel={() => setEditingId(null)}
                onSaved={() => {
                  setEditingId(null);
                  qc.invalidateQueries({ queryKey: queryKeys.adminYears });
                  qc.invalidateQueries({ queryKey: queryKeys.publicYears });
                }}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── 연도 행 컴포넌트 (인라인 수정) ──────────────────────────

function YearRow({
  year,
  isEditing,
  onEdit,
  onCancel,
  onSaved,
}: {
  year: AdminYearItem;
  isEditing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const {
    register,
    handleSubmit,
  } = useForm<UpdateYearInput>({
    resolver: zodResolver(UpdateYearSchema),
    defaultValues: {
      title: year.title ?? '',
      isOpen: year.isOpen,
      sortOrder: year.sortOrder,
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: UpdateYearInput) =>
      adminYearApi.update(year.id, {
        title: data.title || undefined,
        isOpen: data.isOpen,
        sortOrder: data.sortOrder,
      }),
    onSuccess: () => onSaved(),
  });

  if (!isEditing) {
    return (
      <tr>
        <td>{year.year}</td>
        <td>{year.title ?? '-'}</td>
        <td>{year.isOpen ? '허용' : '잠금'}</td>
        <td>{year.sortOrder}</td>
        <td>{year.projectCount}</td>
        <td>
          <button className="btn btn--secondary btn--small" onClick={onEdit}>
            수정
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{year.year}</td>
      <td>
        <input type="text" {...register('title')} style={{ width: '120px' }} />
      </td>
      <td>
        <label>
          <input type="checkbox" {...register('isOpen')} />
        </label>
      </td>
      <td>
        <input
          type="number"
          {...register('sortOrder', { valueAsNumber: true })}
          style={{ width: '60px' }}
        />
      </td>
      <td>{year.projectCount}</td>
      <td>
        <button
          className="btn btn--primary btn--small"
          onClick={handleSubmit((d) => updateMutation.mutate(d))}
          disabled={updateMutation.isPending}
        >
          저장
        </button>
        <button className="btn btn--secondary btn--small" onClick={onCancel}>
          취소
        </button>
        {updateMutation.error && (
          <span className="field-error">
            {getApiErrorMessage(updateMutation.error)}
          </span>
        )}
      </td>
    </tr>
  );
}
