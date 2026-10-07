import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
	UpdateExhibitionSchema,
	type UpdateExhibitionInput,
} from '../../../contracts/schemas';
import type { AdminExhibitionItem } from '../../../contracts';
import { ResponsiveImage } from '../../../components/common';
import { Button, CheckboxField, TextField } from '../../../components/ui';
import DirectImageUploadWidget from '../../../components/DirectImageUploadWidget';
import { adminExhibitionApi, getApiErrorMessage } from '../../../lib/api';
import { VisibilitySelect } from '../../../components/VisibilitySelect';
import { visibilityLabels } from '../../../lib/visibility';
import { ProjectPosterPreview } from '../../../components/project/editor/ProjectPosterPreview';
import { env } from '../../../lib/env';

export const modificationHint =
	'공개 범위와 별개로, 일반 사용자의 신규 작품 등록과 등록자·팀원의 직접 수정·삭제를 허용합니다. 허용하지 않으면 기존 작품의 변경은 운영자 승인이 필요합니다.';
export const orderHint =
	'숫자가 작을수록 먼저 표시됩니다. 같은 값이면 최신 연도가 먼저 표시됩니다.';

export function ExhibitionSummary({
	year,
	expanded,
	onEdit,
	disabled,
	highlighted,
}: {
	year: AdminExhibitionItem;
	expanded: boolean;
	onEdit: () => void;
	disabled: boolean;
	highlighted: boolean;
}) {
	return (
		<div
			className={`exhibition-summary${highlighted ? ' exhibition-summary--new' : ''}`}
		>
			<div className="exhibition-summary__identity">
				<ExhibitionPoster year={year} sizes="44px" />
				<div className="exhibition-summary__title">
					<strong title={year.title || '제목 없는 전시회'}>
						{year.title || '제목 없는 전시회'}
					</strong>
					<small>
						{year.year}년 · 노출 순서 {year.sortOrder}
						{highlighted && ' · 추가됨'}
					</small>
				</div>
			</div>
			<div className="exhibition-summary__states">
				{env.VISIBILITY_CONTROLS_ENABLED && (
					<span>
						<small>공개 범위</small>
						{visibilityLabels[year.visibility]}
					</span>
				)}
				<span>
					<small>작품 등록·변경</small>
					<span
						className={`badge ${(year.isModificationEnabled ?? year.isUploadEnabled) ? 'badge--published' : 'badge--archived'}`}
					>
						{(year.isModificationEnabled ?? year.isUploadEnabled)
							? '허용'
							: '비허용'}
					</span>
				</span>
				<span>
					<small>등록 작품</small>
					{year.projectCount}개
				</span>
			</div>
			<Button
				variant="secondary"
				onClick={onEdit}
				disabled={disabled}
				aria-label={expanded ? '닫기' : '설정'}
				aria-haspopup="dialog"
				aria-expanded={expanded}
				aria-controls={`exhibition-panel-${year.id}`}
			>
				{expanded ? '닫기' : '설정'}
			</Button>
		</div>
	);
}

// Mounted only while selected: reopening always starts with the latest saved settings.
// Poster controls live separately so cancelling settings never interrupts an upload.
export function ExhibitionSettings({
	year,
	onCancel,
	onSaved,
	onPendingChange,
}: {
	year: AdminExhibitionItem;
	onCancel: () => void;
	onSaved: (updated: AdminExhibitionItem) => void;
	onPendingChange: (pending: boolean) => void;
}) {
	const {
		register,
		handleSubmit,
		control,
		formState: { errors, isDirty },
	} = useForm<UpdateExhibitionInput>({
		resolver: zodResolver(UpdateExhibitionSchema),
		defaultValues: {
			title: year.title ?? '',
			visibility: year.visibility,
			isModificationEnabled: year.isModificationEnabled ?? year.isUploadEnabled,
			sortOrder: year.sortOrder,
		},
	});
	const visibility = useWatch({ control, name: 'visibility' });
	const mutation = useMutation({
		mutationFn: (values: UpdateExhibitionInput) =>
			adminExhibitionApi.update(year.id, {
				title: values.title ?? '',
				sortOrder: values.sortOrder,
				isModificationEnabled: values.isModificationEnabled,
				...(env.VISIBILITY_CONTROLS_ENABLED
					? { visibility: values.visibility }
					: {}),
			}),
		onSuccess: onSaved,
		onSettled: () => onPendingChange(false),
	});
	return (
		<form
			noValidate
			onSubmit={handleSubmit((values) => {
				if (!isDirty || mutation.isPending) return;
				onPendingChange(true);
				mutation.mutate(values);
			})}
			className="exhibition-settings"
		>
			<h3>기본 정보</h3>
			<div className="exhibition-settings__primary">
				<TextField
					label="연도"
					value={year.year}
					readOnly
					hint="변경할 수 없습니다."
				/>
				<TextField
					label="제목"
					{...register('title')}
					error={errors.title?.message}
					hint="100자 이내 · 비우면 제목 없이 저장됩니다."
					autoFocus
				/>
			</div>
			<div className="exhibition-settings__options">
				{env.VISIBILITY_CONTROLS_ENABLED && (
					<div className="form-field">
						<label htmlFor={`visibility-${year.id}`}>공개 범위 *</label>
						<VisibilitySelect
							id={`visibility-${year.id}`}
							value={visibility ?? ''}
							{...register('visibility')}
							required
						/>
						<p className="field-hint">전시회와 작품을 볼 수 있는 대상입니다.</p>
					</div>
				)}
				<TextField
					label="노출 순서"
					type="number"
					{...register('sortOrder', { valueAsNumber: true })}
					error={
						errors.sortOrder
							? '노출 순서는 0 이상의 안전한 정수를 입력하세요.'
							: undefined
					}
				/>
			</div>
			<p className="field-hint">{orderHint}</p>

			<CheckboxField
				label="작품 등록·변경 허용"
				{...register('isModificationEnabled')}
				hint={modificationHint}
			/>
			{mutation.error && (
				<p className="field-error" role="alert">
					설정을 저장하지 못했습니다. {getApiErrorMessage(mutation.error)}
				</p>
			)}
			<div className="exhibition-actions">
				<Button type="submit" disabled={!isDirty || mutation.isPending}>
					{mutation.isPending ? '저장 중…' : '설정 저장'}
				</Button>
				<Button
					variant="secondary"
					onClick={onCancel}
					disabled={mutation.isPending}
				>
					설정 취소
				</Button>
				<span className="field-hint">
					위 설정은 저장 버튼을 눌러야 반영됩니다.
				</span>
			</div>
		</form>
	);
}

function formatPosterSize(size?: number): string {
	if (!size) return '';
	if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`;
	return `${Math.max(1, Math.round(size / 1024))}KB`;
}

export function YearPosterControls({
	year,
	compact = false,
	large = false,
}: {
	year: AdminExhibitionItem;
	compact?: boolean;
	large?: boolean;
}) {
	const qc = useQueryClient();
	const [notice, setNotice] = useState('');
	const [directUploadBusy, setDirectUploadBusy] = useState(false);

	const invalidate = () => {
		// Keep cached data and mounted uploads while refreshing visibility-dependent views.
		void qc.invalidateQueries();
	};

	const deletePosterMutation = useMutation({
		mutationFn: () => adminExhibitionApi.deletePoster(year.id),
		onSuccess: () => {
			invalidate();
			setNotice('포스터가 삭제되었습니다.');
		},
	});

	const handleDelete = () => {
		if (!year.poster) return;
		if (
			window.confirm(
				`${year.title || year.year} 전시회 포스터를 삭제하시겠습니까?`,
			)
		) {
			deletePosterMutation.mutate();
		}
	};

	const isBusy = directUploadBusy || deletePosterMutation.isPending;
	const sizeLabel = formatPosterSize(year.posterSize);

	return (
		<div
			className={`admin-exhibition-poster${compact ? ' admin-exhibition-poster--compact' : ''}`}
		>
			<ExhibitionPoster
				year={year}
				sizes={
					large ? '(max-width: 700px) 240px, 300px' : compact ? '72px' : '120px'
				}
			/>
			<div className="admin-exhibition-poster__body">
				{year.posterOriginalName && (
					<span
						className="admin-exhibition-poster__name"
						title={year.posterOriginalName}
					>
						{year.posterOriginalName}
					</span>
				)}
				{sizeLabel && (
					<span className="admin-exhibition-poster__size">{sizeLabel}</span>
				)}
				<div className="admin-exhibition-poster__actions">
					<DirectImageUploadWidget
						owner={{ type: 'EXHIBITION', id: year.id }}
						kind="POSTER"
						hideTitle
						onComplete={() => {
							invalidate();
							setNotice('포스터가 변경되었습니다.');
						}}
						onBusyChange={setDirectUploadBusy}
					/>
					{year.poster && (
						<button
							type="button"
							className="btn btn--danger btn--small"
							onClick={handleDelete}
							disabled={isBusy}
						>
							포스터 삭제
						</button>
					)}
				</div>
				{notice && <p role="status">{notice}</p>}
				{deletePosterMutation.error && (
					<span className="field-error">
						{getApiErrorMessage(deletePosterMutation.error)}
					</span>
				)}
			</div>
		</div>
	);
}

function ExhibitionPoster({
	year,
	sizes,
}: {
	year: AdminExhibitionItem;
	sizes: string;
}) {
	const title = `${year.title || year.year} 전시회`;
	if (!year.poster)
		return (
			<div className="admin-exhibition-poster__preview">
				<span>
					포스터
					<br />
					없음
				</span>
			</div>
		);
	return (
		<ProjectPosterPreview
			image={year.poster}
			title={title}
			triggerClassName="admin-exhibition-poster__preview exhibition-poster-trigger"
			trigger={
				<ResponsiveImage
					image={year.poster}
					alt={`${title} 포스터`}
					sizes={sizes}
					loading="lazy"
					decoding="async"
				/>
			}
		/>
	);
}
