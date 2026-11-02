import { SelectControl } from '../../../components/ui';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BuildReview, BuildReviewSummary } from '@pcu/contracts';
import { api } from '../../../lib/api/client';
import { env } from '../../../lib/env';
import { getApiErrorMessage } from '../../../lib/api';

export function BuildReviewPanel({ projectId }: { projectId?: number }) {
	const query = useQuery({
		queryKey: ['build-reviews', projectId],
		queryFn: () =>
			api.get<BuildReviewSummary[]>(`/api/admin/build-reviews${projectId ? `?projectId=${projectId}` : ''}`),
		refetchInterval: 15000,
	});
	return (
		<section aria-label="빌드 검토">
			<h2>빌드 검토</h2>
			{query.isLoading && <p>검토 목록을 불러오는 중입니다.</p>}
			{query.error && <p role="alert">{getApiErrorMessage(query.error)}</p>}
			{query.data?.length === 0 && <p>검토 대기 중인 빌드가 없습니다.</p>}
			{query.data?.map((review) => (
				<ReviewSummary key={`${review.id}:${review.version}`} review={review} />
			))}
		</section>
	);
}
function ReviewSummary({ review }: { review: BuildReviewSummary }) {
	const [open, setOpen] = useState(false);
	const detail = useQuery({
		queryKey: ['build-reviews', 'detail', review.id, review.version],
		queryFn: () => api.get<BuildReview>(`/api/admin/build-reviews/${review.id}`),
		enabled: open,
	});
	return (
		<details className="card" onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary>
				{review.originalName} · {review.kind === 'WEBGL' ? '웹 빌드' : '게임 빌드'} ·{' '}
				{(review.totalBytes / 1024 / 1024).toFixed(1)} MiB
			</summary>
			{open && detail.isLoading && <p>검토 내용을 불러오는 중입니다.</p>}
			{open && detail.error && <p role="alert">{getApiErrorMessage(detail.error)}</p>}
			{open && detail.data && <Review review={detail.data} />}
		</details>
	);
}
function Review({ review }: { review: BuildReview }) {
	const qc = useQueryClient();
	const [reason, setReason] = useState(''),
		[entry, setEntry] = useState(review.inspection.entryPath ?? '');
	const [busy, setBusy] = useState(false),
		[error, setError] = useState<string | null>(null);
	async function decide(decision: 'APPROVED' | 'REJECTED') {
		setBusy(true);
		setError(null);
		try {
			await api.post(`/api/admin/build-reviews/${review.id}/decision`, {
				decision,
				reason,
				version: review.version,
				...(decision === 'APPROVED' && review.kind === 'WEBGL' && !review.inspection.entryPath
					? { entryPath: entry }
					: {}),
			});
			await qc.invalidateQueries({ queryKey: ['build-reviews'] });
		} catch (cause) {
			setError(getApiErrorMessage(cause));
		} finally {
			setBusy(false);
		}
	}
	async function download() {
		setBusy(true);
		setError(null);
		try {
			const grant = await api.post<{ url: string }>('/api/file-access', {
				url: `${env.API_BASE_URL}/api/admin/build-reviews/${review.id}/download`,
			});
			const link = document.createElement('a');
			link.href = grant.url;
			link.download = review.originalName;
			link.rel = 'noopener noreferrer';
			link.click();
		} catch (cause) {
			setError(getApiErrorMessage(cause));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div>
			<p>
				작품 #{review.projectId} · 엔진 후보: {review.inspection.engines.join(', ') || '미확인'}
			</p>
			<p>{review.inspection.reasons.join(', ')}</p>
			<ul>
				{review.inspection.evidence.map((item, index) => (
					<li key={index}>{item}</li>
				))}
			</ul>
			<details>
				<summary>파일 목록 ({review.inspection.files.length})</summary>
				<ul>
					{review.inspection.files.map((file) => (
						<li key={file.path}>
							{file.path} · {file.bytes.toLocaleString()} bytes
						</li>
					))}
				</ul>
			</details>
			<button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void download()}>
				원본 다운로드
			</button>
			{review.kind === 'WEBGL' && !review.inspection.entryPath && (
				<label>
					실행 HTML
					<SelectControl value={entry} onChange={(event) => setEntry(event.target.value)}>
						<option value="">선택해 주세요</option>
						{review.inspection.entryCandidates.map((path) => (
							<option key={path} value={path}>
								{path}
							</option>
						))}
					</SelectControl>
				</label>
			)}
			<label>
				검토 사유
				<textarea value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
			</label>
			<p>구조 검사 결과입니다. 악성 코드나 게임 내용의 적절성을 인증하지 않습니다.</p>
			{error && <p role="alert">{error}</p>}
			<button
				type="button"
				className="btn btn--primary"
				disabled={busy || !reason.trim() || (review.kind === 'WEBGL' && !entry)}
				onClick={() => void decide('APPROVED')}
			>
				허용
			</button>{' '}
			<button
				type="button"
				className="btn btn--danger"
				disabled={busy || !reason.trim()}
				onClick={() => void decide('REJECTED')}
			>
				거절
			</button>
		</div>
	);
}
