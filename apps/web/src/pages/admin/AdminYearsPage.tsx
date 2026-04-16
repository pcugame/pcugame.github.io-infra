import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
	CreateExhibitionSchema,
	UpdateExhibitionSchema,
	type CreateExhibitionInput,
	type UpdateExhibitionInput,
} from '../../contracts/schemas';
import type { AdminExhibitionItem } from '../../contracts';
import { adminExhibitionApi, adminExportApi, isApiError, getApiErrorMessage } from '../../lib/api';
import type { ExportResult } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { useMe } from '../../features/auth';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../../components/common';

export default function AdminYearsPage() {
	const qc = useQueryClient();
	const { user } = useMe();
	const isAdmin = user?.role === 'ADMIN';

	// ── NAS 내보내기 ──────────────────────────────────────────
	const [exportResult, setExportResult] = useState<{ year: number; result: ExportResult } | null>(null);
	const [exportError, setExportError] = useState<{ year: number; message: string } | null>(null);

	const exportMutation = useMutation({
		mutationFn: (year: number) => adminExportApi.run(year),
		onSuccess: (result, year) => {
			if (result.aborted) {
				setExportError({
					year,
					message: `내보내기가 중단되었습니다. (다운로드: ${result.downloaded}, 실패: ${result.failed})`,
				});
				setExportResult(null);
			} else {
				setExportResult({ year, result });
				setExportError(null);
			}
		},
		onError: (err, year) => {
			if (isApiError(err) && err.status === 409) {
				setExportError({
					year,
					message: '다른 관리자가 이미 내보내기를 실행 중입니다. 잠시 후 다시 시도해주세요.',
				});
			} else {
				setExportError({ year, message: getApiErrorMessage(err) });
			}
			setExportResult(null);
		},
	});

	const isAnyExporting = exportMutation.isPending;

	const handleExport = (year: number) => {
		if (!window.confirm(
			`${year}년도 에셋을 NAS로 내보내시겠습니까?\n\n대용량 파일 다운로드가 포함되어 수 분이 소요될 수 있습니다.`
		)) return;
		setExportResult(null);
		setExportError(null);
		exportMutation.mutate(year);
	};

	// 내보내기 중 새로고침/탭 닫기 경고
	useEffect(() => {
		if (!isAnyExporting) return;
		const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	}, [isAnyExporting]);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: queryKeys.adminExhibitions,
		queryFn: adminExhibitionApi.list,
	});

	// ── 연도 생성 ─────────────────────────────────────────────
	const {
		register: regCreate,
		handleSubmit: handleCreate,
		formState: { errors: createErrors },
		reset: resetCreate,
	} = useForm<CreateExhibitionInput>({
		resolver: zodResolver(CreateExhibitionSchema),
		defaultValues: {
			year: new Date().getFullYear(),
			title: '',
			isUploadEnabled: true,
			sortOrder: 0,
		},
	});

	const createMutation = useMutation({
		mutationFn: (data: CreateExhibitionInput) =>
			adminExhibitionApi.create({
				year: data.year,
				title: data.title || undefined,
				isUploadEnabled: data.isUploadEnabled,
				sortOrder: data.sortOrder,
			}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.adminExhibitions });
			qc.invalidateQueries({ queryKey: queryKeys.publicYears });
			resetCreate();
		},
	});

	// ── 연도 삭제 ──────────────────────────────────────────────
	const deleteMutation = useMutation({
		mutationFn: (id: number) => adminExhibitionApi.delete(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.adminExhibitions });
			qc.invalidateQueries({ queryKey: queryKeys.publicYears });
		},
	});

	const handleDelete = (year: AdminExhibitionItem) => {
		const msg = year.projectCount > 0
			? `"${year.title || year.year}" 전시회를 삭제하시겠습니까?\n\n이 전시회에 등록된 ${year.projectCount}개의 작품도 함께 삭제됩니다. (파일은 유지됨)`
			: `"${year.title || year.year}" 전시회를 삭제하시겠습니까?`;
		if (window.confirm(msg)) {
			deleteMutation.mutate(year.id);
		}
	};

	// ── 연도 수정 (인라인) ────────────────────────────────────
	const [editingId, setEditingId] = useState<number | null>(null);

	if (isLoading) return <LoadingSpinner />;
	if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;

	const years = data?.items ?? [];

	return (
		<div className="admin-years-page">
			<div className="admin-page-header">
				<div className="admin-page-header__text">
					<h1>전시회 추가</h1>
				</div>
			</div>

			{/* ── 새 연도 생성 ────────────────────────────────────── */}
			<form
				onSubmit={handleCreate((d) => createMutation.mutate(d))}
				className="year-create-form admin-card"
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
							<input type="checkbox" {...regCreate('isUploadEnabled')} />
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

			{/* ── 내보내기 결과/에러 ─────────────────────────────── */}
			{exportResult && (
				<div className="admin-card" style={{
					background: exportResult.result.failed > 0
						? 'var(--color-warning-bg, #fff3e0)'
						: 'var(--color-success-bg, #e8f5e9)',
					padding: '1rem',
				}}>
					<strong>{exportResult.year}년도 내보내기 완료:</strong>{' '}
					{exportResult.result.downloaded}개 다운로드, {exportResult.result.skipped}개 스킵
					{exportResult.result.failed > 0 && (
						<>, <span style={{ color: 'var(--color-error, #c62828)' }}>{exportResult.result.failed}개 실패</span></>
					)}
				</div>
			)}
			{exportError && (
				<div className="admin-card" style={{ background: 'var(--color-error-bg, #fce4ec)', padding: '1rem' }}>
					<strong>{exportError.year}년도 내보내기 실패:</strong> {exportError.message}
				</div>
			)}

			{/* ── 연도 목록 ───────────────────────────────────────── */}
			{years.length === 0 ? (
				<EmptyState message="등록된 연도가 없습니다." />
			) : (
				<>
					{/* Desktop: table */}
					<div className="admin-card admin-desktop-only">
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
											qc.invalidateQueries({ queryKey: queryKeys.adminExhibitions });
											qc.invalidateQueries({ queryKey: queryKeys.publicYears });
										}}
										onDelete={() => handleDelete(y)}
										isDeleting={deleteMutation.isPending}
										isAdmin={isAdmin}
										onExport={() => handleExport(y.year)}
										isExporting={exportMutation.isPending && exportMutation.variables === y.year}
										isAnyExporting={isAnyExporting}
									/>
								))}
							</tbody>
						</table>
					</div>

					{/* Mobile: card list */}
					<div className="admin-mobile-cards">
						{years.map((y) => (
							<YearMobileCard
								key={y.id}
								year={y}
								isEditing={editingId === y.id}
								onEdit={() => setEditingId(y.id)}
								onCancel={() => setEditingId(null)}
								onSaved={() => {
									setEditingId(null);
									qc.invalidateQueries({ queryKey: queryKeys.adminExhibitions });
									qc.invalidateQueries({ queryKey: queryKeys.publicYears });
								}}
								onDelete={() => handleDelete(y)}
								isDeleting={deleteMutation.isPending}
								isAdmin={isAdmin}
								onExport={() => handleExport(y.year)}
								isExporting={exportMutation.isPending && exportMutation.variables === y.year}
								isAnyExporting={isAnyExporting}
							/>
						))}
					</div>
				</>
			)}
		</div>
	);
}

// ── 연도 모바일 카드 (모바일 전용) ──────────────────────────

function YearMobileCard({
	year,
	isEditing,
	onEdit,
	onCancel,
	onSaved,
	onDelete,
	isDeleting,
	isAdmin,
	onExport,
	isExporting,
	isAnyExporting,
}: {
	year: AdminExhibitionItem;
	isEditing: boolean;
	onEdit: () => void;
	onCancel: () => void;
	onSaved: () => void;
	onDelete: () => void;
	isDeleting: boolean;
	isAdmin: boolean;
	onExport: () => void;
	isExporting: boolean;
	isAnyExporting: boolean;
}) {
	const {
		register,
		handleSubmit,
	} = useForm<UpdateExhibitionInput>({
		resolver: zodResolver(UpdateExhibitionSchema),
		defaultValues: {
			title: year.title ?? '',
			isUploadEnabled: year.isUploadEnabled,
			sortOrder: year.sortOrder,
		},
	});

	const updateMutation = useMutation({
		mutationFn: (data: UpdateExhibitionInput) =>
			adminExhibitionApi.update(year.id, {
				title: data.title || undefined,
				isUploadEnabled: data.isUploadEnabled,
				sortOrder: data.sortOrder,
			}),
		onSuccess: () => onSaved(),
	});

	if (isEditing) {
		return (
			<div className="admin-ycard admin-ycard--editing">
				<div className="admin-ycard__header">
					<span className="admin-ycard__year">{year.year}</span>
				</div>
				<form
					className="admin-ycard__form"
					onSubmit={handleSubmit((d) => updateMutation.mutate(d))}
				>
					<div className="form-field" style={{ marginBottom: 0 }}>
						<label htmlFor={`m-title-${year.id}`}>제목</label>
						<input id={`m-title-${year.id}`} type="text" {...register('title')} />
					</div>
					<div className="admin-ycard__row">
						<div className="form-field form-field--checkbox" style={{ marginBottom: 0 }}>
							<label>
								<input type="checkbox" {...register('isUploadEnabled')} />
								업로드 허용
							</label>
						</div>
						<div className="form-field" style={{ marginBottom: 0, flex: '0 0 auto' }}>
							<label htmlFor={`m-sort-${year.id}`}>정렬</label>
							<input
								id={`m-sort-${year.id}`}
								type="number"
								{...register('sortOrder', { valueAsNumber: true })}
								style={{ width: '70px' }}
							/>
						</div>
					</div>
					<div className="admin-ycard__actions">
						<button
							type="submit"
							className="btn btn--primary btn--small"
							disabled={updateMutation.isPending}
						>
							{updateMutation.isPending ? '저장 중…' : '저장'}
						</button>
						<button
							type="button"
							className="btn btn--secondary btn--small"
							onClick={onCancel}
						>
							취소
						</button>
					</div>
					{updateMutation.error && (
						<span className="field-error">
							{getApiErrorMessage(updateMutation.error)}
						</span>
					)}
				</form>
			</div>
		);
	}

	return (
		<div className="admin-ycard">
			<div className="admin-ycard__header">
				<span className="admin-ycard__year">{year.year}</span>
				<div style={{ display: 'flex', gap: '0.25rem' }}>
					{isAdmin && (
						<button
							className="btn btn--secondary btn--small"
							onClick={onExport}
							disabled={isAnyExporting}
						>
							{isExporting ? 'NAS 내보내는 중…' : 'NAS 내보내기'}
						</button>
					)}
					<button className="btn btn--secondary btn--small" onClick={onEdit}>
						수정
					</button>
					<button
						className="btn btn--danger btn--small"
						onClick={onDelete}
						disabled={isDeleting || isAnyExporting}
					>
						삭제
					</button>
				</div>
			</div>
			<div className="admin-ycard__details">
				{year.title && (
					<span className="admin-ycard__detail">
						<span className="admin-ycard__label">제목</span> {year.title}
					</span>
				)}
				<span className="admin-ycard__detail">
					<span className="admin-ycard__label">업로드</span>{' '}
					{year.isUploadEnabled ? '허용' : '잠금'}
				</span>
				<span className="admin-ycard__detail">
					<span className="admin-ycard__label">작품</span> {year.projectCount}개
				</span>
			</div>
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
	onDelete,
	isDeleting,
	isAdmin,
	onExport,
	isExporting,
	isAnyExporting,
}: {
	year: AdminExhibitionItem;
	isEditing: boolean;
	onEdit: () => void;
	onCancel: () => void;
	onSaved: () => void;
	onDelete: () => void;
	isDeleting: boolean;
	isAdmin: boolean;
	onExport: () => void;
	isExporting: boolean;
	isAnyExporting: boolean;
}) {
	const {
		register,
		handleSubmit,
	} = useForm<UpdateExhibitionInput>({
		resolver: zodResolver(UpdateExhibitionSchema),
		defaultValues: {
			title: year.title ?? '',
			isUploadEnabled: year.isUploadEnabled,
			sortOrder: year.sortOrder,
		},
	});

	const updateMutation = useMutation({
		mutationFn: (data: UpdateExhibitionInput) =>
			adminExhibitionApi.update(year.id, {
				title: data.title || undefined,
				isUploadEnabled: data.isUploadEnabled,
				sortOrder: data.sortOrder,
			}),
		onSuccess: () => onSaved(),
	});

	if (!isEditing) {
		return (
			<tr>
				<td>{year.year}</td>
				<td>{year.title ?? '-'}</td>
				<td>{year.isUploadEnabled ? '허용' : '잠금'}</td>
				<td>{year.sortOrder}</td>
				<td>{year.projectCount}</td>
				<td>
					{isAdmin && (
						<button
							className="btn btn--secondary btn--small"
							onClick={onExport}
							disabled={isAnyExporting}
							style={{ marginRight: '0.25rem' }}
						>
							{isExporting ? '내보내는 중…' : 'NAS 내보내기'}
						</button>
					)}
					<button className="btn btn--secondary btn--small" onClick={onEdit}>
						수정
					</button>
					<button
						className="btn btn--danger btn--small"
						onClick={onDelete}
						disabled={isDeleting || isAnyExporting}
						style={{ marginLeft: '0.25rem' }}
					>
						삭제
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
					<input type="checkbox" {...register('isUploadEnabled')} />
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
