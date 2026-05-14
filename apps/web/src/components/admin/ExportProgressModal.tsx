import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminExportApi } from '../../lib/api';
import type { ExportResult } from '../../lib/api';
import type { ExportFileStatus, ExportPhase } from '../../contracts';
import { queryKeys } from '../../lib/query';

interface Props {
	open: boolean;
	year: number;
	isRunning: boolean;
	result: ExportResult | null;
	error: string | null;
	onClose: () => void;
}

const PHASE_LABEL: Record<ExportPhase, string> = {
	preparing: '준비 중…',
	downloading: '다운로드 중…',
	finishing: '마무리 중…',
};

const FILE_STATUS_LABEL: Record<ExportFileStatus, string> = {
	pending: '대기',
	saving: '저장중',
	saved: '완료',
	skipped: '스킵',
	failed: '실패',
};

export function ExportProgressModal({
	open,
	year,
	isRunning,
	result,
	error,
	onClose,
}: Props) {
	// 진행 중일 때만 폴링. 끝나면 자동 중지.
	const { data: status } = useQuery({
		queryKey: queryKeys.adminExportStatus,
		queryFn: adminExportApi.status,
		enabled: open && isRunning,
		refetchInterval: open && isRunning ? 1500 : false,
		refetchIntervalInBackground: true,
		staleTime: 0,
	});

	// ESC: 실행 중에는 무시
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (isRunning) return;
			onClose();
		};
		document.addEventListener('keydown', onKey);
		document.body.style.overflow = 'hidden';
		return () => {
			document.removeEventListener('keydown', onKey);
			document.body.style.overflow = '';
		};
	}, [open, isRunning, onClose]);

	if (!open) return null;

	const handleOverlayClick = (e: React.MouseEvent) => {
		if (isRunning) return;
		if (e.target === e.currentTarget) onClose();
	};

	const progress = status?.progress ?? null;
	const phaseLabel = progress ? PHASE_LABEL[progress.phase] : '준비 중…';
	const projectsTotal = progress?.totalProjects ?? 0;
	const projectsDone = progress
		? Math.min(progress.currentProjectIndex + (progress.totalProjects > 0 ? 1 : 0), progress.totalProjects)
		: 0;
	const downloaded = progress?.downloaded ?? 0;
	const skipped = progress?.skipped ?? 0;
	const failed = progress?.failed ?? 0;
	const totalFiles = progress?.totalFiles ?? 0;
	const processedFiles = downloaded + skipped + failed;
	const progressPercent = totalFiles > 0
		? Math.min(Math.round((processedFiles / totalFiles) * 100), 100)
		: 0;
	const currentProjectFiles = progress?.currentProjectFiles ?? [];
	const title = isRunning
		? `${year}년 작품 NAS에 저장중...`
		: `${year}년도 NAS 내보내기`;

	return (
		<div className="modal-overlay" onClick={handleOverlayClick}>
			<div
				className="modal-panel export-progress-modal"
				role="dialog"
				aria-modal="true"
				aria-live="polite"
			>
				{!isRunning && (
					<button className="modal-close" onClick={onClose} aria-label="닫기">
						<svg
							width="20"
							height="20"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				)}

				<div className="modal-body">
					<h2 className="modal-title">{title}</h2>

					{isRunning && (
						<div className="export-progress">
							<div className="export-progress__phase">
								<div
									className="spinner"
									aria-label="진행 중"
									style={{ width: 28, height: 28, borderWidth: 3 }}
								/>
								<strong>{phaseLabel}</strong>
							</div>

							<div className="export-progress__bar-wrap">
								<div className="export-progress__bar-meta">
									<span>전체 진행률</span>
									<strong>{progressPercent}%</strong>
								</div>
								<div
									className="export-progress__bar-track"
									role="progressbar"
									aria-label="NAS 내보내기 진행률"
									aria-valuemin={0}
									aria-valuemax={100}
									aria-valuenow={progressPercent}
								>
									<div
										className="export-progress__bar-fill"
										style={{ width: `${progressPercent}%` }}
									/>
								</div>
							</div>

							<dl className="export-progress__stats">
								<dt>프로젝트</dt>
								<dd>
									{projectsTotal > 0
										? `${projectsDone} / ${projectsTotal}`
										: '집계 중…'}
								</dd>

								{progress?.currentProjectTitle && (
									<>
										<dt>현재 작품</dt>
										<dd className="export-progress__current-title">
											{progress.currentProjectTitle}
										</dd>
									</>
								)}

								<dt>파일</dt>
								<dd>
									<span>다운로드 <strong>{downloaded}</strong></span>
									<span className="export-progress__muted"> · </span>
									<span>스킵 <strong>{skipped}</strong></span>
									{failed > 0 && (
										<>
											<span className="export-progress__muted"> · </span>
											<span className="export-progress__danger">
												실패 <strong>{failed}</strong>
											</span>
										</>
									)}
									{totalFiles > 0 && (
										<span className="export-progress__muted">
											{' '}/ 총 {totalFiles}개
										</span>
									)}
								</dd>
							</dl>

							<div className="export-progress__file-panel">
								<div className="export-progress__file-panel-head">
									<strong>진행중 작품 파일</strong>
									<span>
										{currentProjectFiles.length > 0
											? `${currentProjectFiles.length}개`
											: '집계 중'}
									</span>
								</div>
								{currentProjectFiles.length > 0 ? (
									<ul className="export-progress__file-list">
										{currentProjectFiles.map((file) => (
											<li className="export-progress__file-item" key={file.assetId}>
												<div className="export-progress__file-main">
													<span className="export-progress__file-name">
														{file.fileName}
													</span>
													{file.originalName && file.originalName !== file.fileName && (
														<span className="export-progress__file-original">
															원본: {file.originalName}
														</span>
													)}
												</div>
												<span
													className={`export-progress__file-status export-progress__file-status--${file.status}`}
												>
													{FILE_STATUS_LABEL[file.status]}
												</span>
											</li>
										))}
									</ul>
								) : (
									<p className="export-progress__file-empty">
										현재 작품의 파일 목록을 불러오는 중입니다.
									</p>
								)}
							</div>

							<p className="export-progress__notice">
								내보내기 중에는 이 창을 닫을 수 없습니다. 작업이 끝날 때까지 잠시만
								기다려주세요. (탭을 닫거나 새로고침하면 진행 중인 작업이 중단됩니다.)
							</p>
						</div>
					)}

					{!isRunning && error && (
						<div
							style={{
								background: 'var(--color-error-bg, #fce4ec)',
								padding: '1rem',
								borderRadius: 10,
								marginBottom: '1rem',
							}}
						>
							<strong>{year}년도 내보내기 실패</strong>
							<p style={{ margin: '0.35rem 0 0' }}>{error}</p>
						</div>
					)}

					{!isRunning && result && !error && (
						<div
							style={{
								background:
									result.failed > 0
										? 'var(--color-warning-bg, #fff3e0)'
										: 'var(--color-success-bg, #e8f5e9)',
								padding: '1rem',
								borderRadius: 10,
								marginBottom: '1rem',
							}}
						>
							<strong>{year}년도 내보내기 완료</strong>
							<p style={{ margin: '0.35rem 0 0' }}>
								다운로드 {result.downloaded}개 · 스킵 {result.skipped}개
								{result.failed > 0 && (
									<>
										{' · '}
										<span style={{ color: 'var(--color-danger, #c62828)' }}>
											실패 {result.failed}개
										</span>
									</>
								)}
							</p>
							{result.aborted && (
								<p
									style={{
										margin: '0.35rem 0 0',
										color: 'var(--color-text-muted)',
									}}
								>
									(중단되어 일부만 처리되었습니다.)
								</p>
							)}
						</div>
					)}

					{!isRunning && (
						<div
							style={{
								display: 'flex',
								justifyContent: 'flex-end',
								marginTop: '0.5rem',
							}}
						>
							<button className="btn btn--primary" onClick={onClose}>
								닫기
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
