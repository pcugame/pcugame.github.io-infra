import {
	Button,
	CheckboxField,
	TextField,
	SelectField,
} from '../../components/ui';
import { useViewerKey } from '../../lib/query';
import { useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
	CreateExhibitionSchema,
	type CreateExhibitionInput,
} from '../../contracts/schemas';
import type { AdminExhibitionItem } from '../../contracts';
import {
	adminExhibitionApi,
	adminExportApi,
	isApiError,
	getApiErrorMessage,
} from '../../lib/api';
import type { ExportResult } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { useMe } from '../../features/auth';
import {
	ExhibitionSummary,
	ExhibitionSettings,
	YearPosterControls,
	modificationHint,
	orderHint,
} from '../../features/admin/exhibitions/ExhibitionRows';
import {
	LoadingSpinner,
	ErrorMessage,
	EmptyState,
} from '../../components/common';
import { ExhibitionSettingsDialog } from '../../features/admin/exhibitions/ExhibitionSettingsDialog';
import { ExportProgressModal } from '../../components/admin/ExportProgressModal';

import { VisibilitySelect } from '../../components/VisibilitySelect';
import { env } from '../../lib/env';
import type { Visibility } from '@pcu/contracts';

export default function AdminYearsPage() {
	const viewerKey = useViewerKey();
	const qc = useQueryClient();
	const [createOpen, setCreateOpen] = useState(false);
	const [notice, setNotice] = useState('');
	const [addedId, setAddedId] = useState<number | null>(null);
	const [visitedIds, setVisitedIds] = useState<number[]>([]);
	const [settingsPending, setSettingsPending] = useState(false);
	const [exportYear, setExportYear] = useState('');
	const addedRef = useRef<HTMLDivElement>(null);
	const focusedAddedId = useRef<number | null>(null);
	const [createVisibility, setCreateVisibility] = useState<Visibility | ''>('');
	const { user } = useMe();
	const isAdmin = user?.role === 'ADMIN';

	// ── NAS 내보내기 ──────────────────────────────────────────
	const [exportError, setExportError] = useState<string | null>(null);
	const [modalYear, setModalYear] = useState<number | null>(null);
	const [exportJobId, setExportJobId] = useState<string | null>(null);
	const exportStatus = useQuery({
		queryKey: queryKeys.adminExportStatus,
		queryFn: adminExportApi.status,
		enabled: exportJobId !== null,
		refetchInterval: exportJobId !== null ? 1500 : false,
		refetchIntervalInBackground: true,
		staleTime: 0,
	});

	const exportMutation = useMutation({
		mutationFn: (year: number) => adminExportApi.run(year),
		onSuccess: (job) => {
			setExportJobId(job.jobId);
			setExportError(null);
			void qc.invalidateQueries({ queryKey: queryKeys.adminExportStatus });
		},
		onError: (err) => {
			if (isApiError(err) && err.status === 409) {
				setExportError(
					'다른 관리자가 이미 내보내기를 실행 중입니다. 잠시 후 다시 시도해주세요.',
				);
			} else {
				setExportError(getApiErrorMessage(err));
			}
		},
	});

	const currentExportStatus = exportStatus.data;
	const isCurrentJobTerminal =
		currentExportStatus?.jobId === exportJobId &&
		(currentExportStatus.state === 'READY' ||
			currentExportStatus.state === 'FAILED' ||
			currentExportStatus.state === 'CANCELLED');
	const exportResult: ExportResult | null =
		isCurrentJobTerminal && currentExportStatus?.state === 'READY'
			? (currentExportStatus.result ?? null)
			: null;
	const completedExportError =
		isCurrentJobTerminal && currentExportStatus?.state !== 'READY'
			? (currentExportStatus?.error ??
				(currentExportStatus?.state === 'CANCELLED'
					? '내보내기 작업이 취소되었습니다.'
					: '내보내기 작업이 실패했습니다.'))
			: null;
	const isAnyExporting =
		exportMutation.isPending || (exportJobId !== null && !isCurrentJobTerminal);

	const handleExport = (year: number) => {
		if (
			!window.confirm(
				`${year}년의 모든 전시회(${(data?.items ?? []).filter((item) => item.year === year).length}개)를 포함해 NAS로 내보내시겠습니까?\n\n실제 대상 작품·파일 수는 서버가 준비 과정에서 계산합니다. 목록의 작품 수와 다를 수 있습니다.\n\n대용량 파일 다운로드가 포함되어 수 분이 소요될 수 있습니다.`,
			)
		)
			return;
		setExportError(null);
		setModalYear(year);
		exportMutation.mutate(year);
	};

	const handleModalClose = () => {
		// 진행 중 닫기는 모달 자체에서 막힘 — 여기서는 완료/실패 후만 호출됨
		setModalYear(null);
		setExportError(null);
		setExportJobId(null);
		exportMutation.reset();
	};

	// 내보내기 중 새로고침/탭 닫기 경고
	useEffect(() => {
		if (!isAnyExporting) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	}, [isAnyExporting]);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: viewerKey(queryKeys.adminExhibitions),
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
			isModificationEnabled: true,
			sortOrder: 0,
		},
	});

	const createMutation = useMutation({
		mutationFn: (data: CreateExhibitionInput) =>
			adminExhibitionApi.create({
				visibility: env.VISIBILITY_CONTROLS_ENABLED
					? (createVisibility as Visibility)
					: 'PUBLIC',
				year: data.year,
				title: data.title || undefined,
				isModificationEnabled: data.isModificationEnabled,
				sortOrder: data.sortOrder,
			}),
		onSuccess: (created) => {
			setAddedId(created.id);
			setNotice(`${created.year}년 전시회가 추가되었습니다.`);
			setCreateOpen(false);
			void qc.invalidateQueries();
			resetCreate();
			setCreateVisibility('');
		},
	});

	const [editingId, setEditingId] = useState<number | null>(null);
	const deleteMutation = useMutation({
		mutationFn: (id: number) => adminExhibitionApi.delete(id),
		onSuccess: (_result, deletedId) => {
			qc.setQueriesData<{ items: AdminExhibitionItem[] }>(
				{ queryKey: queryKeys.adminExhibitions },
				(current) =>
					current
						? { items: current.items.filter((item) => item.id !== deletedId) }
						: current,
			);
			setNotice(
				'전시회가 삭제되었습니다. 제출된 파일은 서버에서 순차적으로 정리됩니다.',
			);
			setEditingId(null);
			void qc.invalidateQueries();
		},
	});
	const handleDelete = (year: AdminExhibitionItem) => {
		if (
			window.confirm(
				`"${year.title || '제목 없는 전시회'}" (${year.year}년) 전시회를 삭제하시겠습니까?\n\n전시회와 등록된 작품 ${year.projectCount}개가 함께 삭제됩니다. 전시회 포스터와 작품에 제출된 파일(WebGL 배포 파일 포함)도 서버의 삭제 작업으로 순차 정리됩니다. 진행 중인 작품 업로드도 정리 대상입니다. 되돌릴 수 없습니다.`,
			)
		) {
			setNotice('');
			deleteMutation.mutate(year.id);
		}
	};
	const closeSettings = () => {
		const id = editingId;
		setEditingId(null);
		requestAnimationFrame(() =>
			document
				.querySelector<HTMLButtonElement>(
					`#exhibition-${id} .exhibition-summary > button`,
				)
				?.focus(),
		);
	};
	const selectExhibition = (id: number) => {
		deleteMutation.reset();
		if (editingId === id) {
			closeSettings();
			return;
		}
		setEditingId(id);
		setVisitedIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
	};
	useEffect(() => {
		if (
			addedId &&
			focusedAddedId.current !== addedId &&
			data?.items.some((item) => item.id === addedId)
		) {
			focusedAddedId.current = addedId;
			addedRef.current?.scrollIntoView({
				block: 'nearest',
				behavior: 'smooth',
			});
			addedRef.current?.focus({ preventScroll: true });
		}
	}, [addedId, data]);

	if (isLoading) return <LoadingSpinner />;
	if (error && !data)
		return <ErrorMessage error={error} onReset={() => refetch()} />;

	const years = data?.items ?? [];

	return (
		<div className="admin-years-page">
			{error && data && (
				<ErrorMessage error={error} onReset={() => refetch()} />
			)}
			<div className="admin-page-header">
				<div className="admin-page-header__text">
					<h1>전시회 관리</h1>
					<p>
						전시회를 선택해 공개 범위, 작품 등록·변경 권한과 포스터를
						관리하세요.
					</p>
				</div>
				<Button
					onClick={() => {
						setCreateOpen(true);
						createMutation.reset();
					}}
					disabled={createOpen}
				>
					전시회 추가
				</Button>
			</div>
			{notice && (
				<p className="exhibition-notice" role="status">
					{notice}
				</p>
			)}
			<div className="exhibition-toolbar">
				<p className="exhibition-list__count">전시회 {years.length}개</p>
				{isAdmin && (
					<details className="exhibition-export admin-card">
						<summary>연도별 NAS 내보내기</summary>
						<p className="field-hint">
							선택한 연도의 모든 전시회를 포함합니다. 실제 대상 작품·파일 수는
							서버에서 계산하며 목록의 작품 수와 다를 수 있습니다.
						</p>
						<div className="exhibition-actions">
							<SelectField
								label="내보낼 연도"
								value={exportYear}
								onChange={(event) => setExportYear(event.target.value)}
								disabled={isAnyExporting}
							>
								<option value="">연도 선택</option>
								{[...new Set(years.map((year) => year.year))].map((year) => (
									<option key={year} value={year}>
										{year}년 · 전시회{' '}
										{years.filter((item) => item.year === year).length}개
									</option>
								))}
							</SelectField>
							<Button
								variant="secondary"
								disabled={!exportYear || isAnyExporting}
								onClick={() => handleExport(Number(exportYear))}
							>
								{isAnyExporting ? '내보내는 중…' : 'NAS 내보내기'}
							</Button>
						</div>
					</details>
				)}
			</div>
			{(createOpen || years.length === 0) && (
				<form
					noValidate
					className="year-create-form admin-card"
					onSubmit={handleCreate((values) => {
						if (!env.VISIBILITY_CONTROLS_ENABLED || createVisibility)
							createMutation.mutate(values);
					})}
				>
					<h2>전시회 추가</h2>
					<div className="exhibition-create-fields">
						<TextField
							label="연도 *"
							type="number"
							{...regCreate('year', { valueAsNumber: true })}
							error={
								createErrors.year
									? '연도는 2021~2100 사이의 정수를 입력하세요.'
									: undefined
							}
						/>
						<TextField
							label="제목"
							{...regCreate('title')}
							error={createErrors.title?.message}
							hint="100자 이내 · 같은 연도에는 제목이 달라야 합니다."
							autoFocus={createOpen}
						/>
						<TextField
							label="노출 순서"
							type="number"
							{...regCreate('sortOrder', { valueAsNumber: true })}
							error={
								createErrors.sortOrder
									? '노출 순서는 0 이상의 안전한 정수를 입력하세요.'
									: undefined
							}
						/>
					</div>
					<p className="field-hint">{orderHint}</p>
					{env.VISIBILITY_CONTROLS_ENABLED && (
						<div className="form-field">
							<label htmlFor="new-visibility">공개 범위 *</label>
							<VisibilitySelect
								id="new-visibility"
								value={createVisibility}
								onChange={(event) =>
									setCreateVisibility(event.target.value as Visibility)
								}
								required
							/>
							<p className="field-hint">
								전시회와 작품을 볼 수 있는 대상을 선택하세요.
							</p>
						</div>
					)}
					<CheckboxField
						label="작품 등록·변경 허용"
						{...regCreate('isModificationEnabled')}
						hint={modificationHint}
					/>
					{createMutation.error && (
						<p className="field-error" role="alert">
							전시회를 추가하지 못했습니다.{' '}
							{getApiErrorMessage(createMutation.error)}
						</p>
					)}
					<div className="exhibition-actions">
						<Button
							type="submit"
							disabled={
								createMutation.isPending ||
								(env.VISIBILITY_CONTROLS_ENABLED && !createVisibility)
							}
						>
							{createMutation.isPending ? '추가 중…' : '추가'}
						</Button>
						{years.length > 0 && (
							<Button
								variant="secondary"
								disabled={createMutation.isPending}
								onClick={() => {
									setCreateOpen(false);
									resetCreate();
									setCreateVisibility('');
									createMutation.reset();
								}}
							>
								취소
							</Button>
						)}
					</div>
				</form>
			)}
			{years.length === 0 ? (
				<EmptyState message="등록된 전시회가 없습니다. 위에서 첫 전시회를 추가하세요." />
			) : (
				<section aria-label="전시회 목록" className="exhibition-list">
					{years.map((year) => (
						<div
							key={year.id}
							id={`exhibition-${year.id}`}
							className="admin-card exhibition-item"
							ref={addedId === year.id ? addedRef : undefined}
							tabIndex={-1}
						>
							<ExhibitionSummary
								year={year}
								expanded={editingId === year.id}
								onEdit={() => selectExhibition(year.id)}
								disabled={settingsPending || deleteMutation.isPending}
								highlighted={addedId === year.id}
							/>
							{visitedIds.includes(year.id) && (
								<ExhibitionSettingsDialog
									id={year.id}
									open={editingId === year.id}
									busy={settingsPending || deleteMutation.isPending}
									onClose={closeSettings}
								>
									{editingId === year.id && (
										<ExhibitionSettings
											year={year}
											onCancel={closeSettings}
											onPendingChange={setSettingsPending}
											onSaved={(updated) => {
												qc.setQueriesData<{ items: AdminExhibitionItem[] }>(
													{ queryKey: queryKeys.adminExhibitions },
													(current) =>
														current
															? {
																	items: current.items.map((item) =>
																		item.id === updated.id ? updated : item,
																	),
																}
															: current,
												);
												setNotice('전시회 설정이 저장되었습니다.');
												closeSettings();
												void qc.invalidateQueries();
											}}
										/>
									)}
									{visitedIds.includes(year.id) && (
										<section
											className="exhibition-poster-section"
											aria-label="포스터 관리"
										>
											<h3>포스터 관리</h3>
											<p className="field-hint">
												업로드·삭제는 별도로 반영되며 설정 취소로 되돌아가지
												않습니다. 창을 닫아도 업로드는 유지됩니다.
											</p>
											<YearPosterControls year={year} large />
										</section>
									)}
									<div className="exhibition-danger">
										<Button
											variant="danger"
											onClick={() => handleDelete(year)}
											disabled={
												deleteMutation.isPending ||
												isAnyExporting ||
												settingsPending
											}
										>
											{deleteMutation.isPending ? '삭제 중…' : '전시회 삭제'}
										</Button>
										<span className="field-hint">
											등록된 작품과 제출된 파일도 삭제 대상입니다.
										</span>
									</div>
									{deleteMutation.error &&
										deleteMutation.variables === year.id && (
											<p className="field-error" role="alert">
												전시회를 삭제하지 못했습니다.{' '}
												{getApiErrorMessage(deleteMutation.error)}
											</p>
										)}
								</ExhibitionSettingsDialog>
							)}
						</div>
					))}
				</section>
			)}

			<ExportProgressModal
				open={modalYear !== null}
				year={modalYear ?? 0}
				isRunning={isAnyExporting}
				status={exportStatus.data}
				result={exportResult}
				error={exportError ?? completedExportError}
				onClose={handleModalClose}
			/>
		</div>
	);
}
