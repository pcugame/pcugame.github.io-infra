import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminExportApi } from '../../lib/api';
import type { ExportResult } from '../../lib/api';
import type { ExportPhase } from '../../contracts';
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

	return (
		<div className="modal-overlay" onClick={handleOverlayClick}>
			<div
				className="modal-panel"
				role="dialog"
				aria-modal="true"
				aria-live="polite"
				style={{ maxWidth: 520 }}
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
					<h2 className="modal-title">{year}년도 NAS 내보내기</h2>

					{isRunning && (
						<div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: '0.85rem',
								}}
							>
								<div
									className="spinner"
									aria-label="진행 중"
									style={{ width: 28, height: 28, borderWidth: 3 }}
								/>
								<strong style={{ fontSize: '1rem' }}>{phaseLabel}</strong>
							</div>

							<dl
								style={{
									margin: 0,
									display: 'grid',
									gridTemplateColumns: 'auto 1fr',
									columnGap: '1rem',
									rowGap: '0.5rem',
									fontSize: '0.92rem',
								}}
							>
								<dt style={{ color: 'var(--color-text-muted)' }}>프로젝트</dt>
								<dd style={{ margin: 0 }}>
									{projectsTotal > 0
										? `${projectsDone} / ${projectsTotal}`
										: '집계 중…'}
								</dd>

								{progress?.currentProjectTitle && (
									<>
										<dt style={{ color: 'var(--color-text-muted)' }}>현재 작품</dt>
										<dd
											style={{
												margin: 0,
												overflow: 'hidden',
												textOverflow: 'ellipsis',
												whiteSpace: 'nowrap',
											}}
										>
											{progress.currentProjectTitle}
										</dd>
									</>
								)}

								<dt style={{ color: 'var(--color-text-muted)' }}>파일</dt>
								<dd style={{ margin: 0 }}>
									<span>다운로드 <strong>{downloaded}</strong></span>
									<span style={{ color: 'var(--color-text-muted)' }}> · </span>
									<span>스킵 <strong>{skipped}</strong></span>
									{failed > 0 && (
										<>
											<span style={{ color: 'var(--color-text-muted)' }}> · </span>
											<span style={{ color: 'var(--color-danger, #dc2626)' }}>
												실패 <strong>{failed}</strong>
											</span>
										</>
									)}
									{totalFiles > 0 && (
										<span style={{ color: 'var(--color-text-muted)' }}>
											{' '}/ 총 {totalFiles}
										</span>
									)}
								</dd>
							</dl>

							<p
								style={{
									margin: 0,
									padding: '0.75rem 1rem',
									background: 'var(--color-bg)',
									border: '1px solid var(--color-border)',
									borderRadius: 10,
									color: 'var(--color-text-muted)',
									fontSize: '0.85rem',
									lineHeight: 1.5,
								}}
							>
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
