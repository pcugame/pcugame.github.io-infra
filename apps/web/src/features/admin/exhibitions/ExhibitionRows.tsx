import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
	UpdateExhibitionSchema,
	type UpdateExhibitionInput,
} from '../../../contracts/schemas';
import type { AdminExhibitionItem } from '../../../contracts';
import { adminExhibitionApi, getApiErrorMessage } from '../../../lib/api';
import type { UploadProgress } from '../../../lib/api';
import { queryKeys } from '../../../lib/query';
import { buildExhibitionPosterFormData } from '../../../lib/utils/formData';
import { UploadProgressModal } from '../../../components/common';

type ExhibitionRowProps = {
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
};

export function YearMobileCard({
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
}: ExhibitionRowProps) {
	const { register, handleSubmit } = useForm<UpdateExhibitionInput>({
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
				<YearPosterControls year={year} compact />
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
			<YearPosterControls year={year} compact />
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

export function YearRow({
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
}: ExhibitionRowProps) {
	const { register, handleSubmit } = useForm<UpdateExhibitionInput>({
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
				<td>
					<YearPosterControls year={year} />
				</td>
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
				<YearPosterControls year={year} />
			</td>
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

function formatPosterSize(size?: number): string {
	if (!size) return '';
	if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`;
	return `${Math.max(1, Math.round(size / 1024))}KB`;
}

function YearPosterControls({
	year,
	compact = false,
}: {
	year: AdminExhibitionItem;
	compact?: boolean;
}) {
	const qc = useQueryClient();
	const inputRef = useRef<HTMLInputElement>(null);
	const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);

	const invalidate = () => {
		qc.invalidateQueries({ queryKey: queryKeys.adminExhibitions });
		qc.invalidateQueries({ queryKey: queryKeys.publicYears });
	};

	const uploadMutation = useMutation({
		mutationFn: (file: File) =>
			adminExhibitionApi.uploadPoster(
				year.id,
				buildExhibitionPosterFormData(file),
				setUploadProgress,
			),
		onSuccess: () => {
			setUploadProgress((prev) => prev ? { ...prev, percent: 100, loaded: prev.total } : prev);
			invalidate();
		},
		onSettled: () => {
			setUploadProgress(null);
			if (inputRef.current) inputRef.current.value = '';
		},
	});

	const deletePosterMutation = useMutation({
		mutationFn: () => adminExhibitionApi.deletePoster(year.id),
		onSuccess: invalidate,
	});

	const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.currentTarget.files?.[0];
		if (!file) return;
		setUploadProgress({ loaded: 0, total: 0, percent: 0 });
		uploadMutation.mutate(file);
	};

	const handleDelete = () => {
		if (!year.posterUrl) return;
		if (window.confirm(`${year.title || year.year} 전시회 포스터를 삭제하시겠습니까?`)) {
			deletePosterMutation.mutate();
		}
	};

	const isBusy = uploadMutation.isPending || deletePosterMutation.isPending;
	const sizeLabel = formatPosterSize(year.posterSize);

	return (
		<div className={`admin-exhibition-poster${compact ? ' admin-exhibition-poster--compact' : ''}`}>
			<UploadProgressModal
				open={uploadMutation.isPending}
				title="전시회 포스터 업로드"
				percent={uploadProgress?.percent}
				loadedBytes={uploadProgress?.loaded}
				totalBytes={uploadProgress?.total}
				status="포스터 전송 및 변환이 끝날 때까지 이 창을 닫거나 새로고침하지 마세요."
			/>

			<div className="admin-exhibition-poster__preview">
				{year.posterUrl ? (
					<img src={year.posterUrl} alt={`${year.title || year.year} 전시회 포스터`} />
				) : (
					<span>{year.year}</span>
				)}
			</div>
			<div className="admin-exhibition-poster__body">
				{year.posterOriginalName && (
					<span className="admin-exhibition-poster__name" title={year.posterOriginalName}>
						{year.posterOriginalName}
					</span>
				)}
				{sizeLabel && (
					<span className="admin-exhibition-poster__size">{sizeLabel}</span>
				)}
				<div className="admin-exhibition-poster__actions">
					<input
						ref={inputRef}
						type="file"
						accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
						className="sr-only"
						onChange={handleFileChange}
					/>
					<button
						type="button"
						className="btn btn--secondary btn--small"
						onClick={() => inputRef.current?.click()}
						disabled={isBusy}
					>
						{uploadMutation.isPending ? '업로드 중…' : year.posterUrl ? '교체' : '업로드'}
					</button>
					{year.posterUrl && (
						<button
							type="button"
							className="btn btn--danger btn--small"
							onClick={handleDelete}
							disabled={isBusy}
						>
							삭제
						</button>
					)}
				</div>
				{(uploadMutation.error || deletePosterMutation.error) && (
					<span className="field-error">
						{getApiErrorMessage(uploadMutation.error ?? deletePosterMutation.error)}
					</span>
				)}
			</div>
		</div>
	);
}
