import { useState, useRef, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { adminImportApi, getApiErrorMessage } from '../../lib/api';
import type { ImportPreviewResult, ImportExecuteResult } from '../../lib/api';
import { queryKeys } from '../../lib/query';

type Step = 'select' | 'preview' | 'confirm' | 'done';

export default function AdminImportPage() {
	const qc = useQueryClient();
	const fileRef = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [step, setStep] = useState<Step>('select');
	const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
	const [result, setResult] = useState<ImportExecuteResult | null>(null);

	const previewMutation = useMutation({
		mutationFn: (f: File) => adminImportApi.preview(f),
		onSuccess: (data) => {
			setPreview(data);
			setStep(data.valid ? 'preview' : 'select');
		},
	});

	const executeMutation = useMutation({
		mutationFn: (f: File) => adminImportApi.execute(f),
		onSuccess: (data) => {
			setResult(data);
			setStep('done');
			qc.invalidateQueries({ queryKey: queryKeys.adminExhibitions });
			qc.invalidateQueries({ queryKey: queryKeys.adminProjects });
		},
	});

	const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const f = e.target.files?.[0] ?? null;
		if (!f) return;

		if (f.size > 10 * 1024 * 1024) {
			alert('파일 크기가 10MB를 초과합니다.');
			return;
		}
		if (!f.name.endsWith('.json')) {
			alert('JSON 파일만 업로드할 수 있습니다.');
			return;
		}

		setFile(f);
		setStep('select');
		setPreview(null);
		setResult(null);
		previewMutation.mutate(f);
	}, [previewMutation]);

	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		const f = e.dataTransfer.files[0];
		if (!f) return;

		if (f.size > 10 * 1024 * 1024) {
			alert('파일 크기가 10MB를 초과합니다.');
			return;
		}
		if (!f.name.endsWith('.json')) {
			alert('JSON 파일만 업로드할 수 있습니다.');
			return;
		}

		setFile(f);
		setStep('select');
		setPreview(null);
		setResult(null);
		previewMutation.mutate(f);
	}, [previewMutation]);

	const handleConfirm = () => {
		if (!file) return;

		const existingExhibitions = preview?.exhibitions.filter(e => !e.isNew) ?? [];
		if (existingExhibitions.length > 0) {
			const names = existingExhibitions
				.map(e => `  - ${e.title} (기존 ${e.existingProjectCount}개 프로젝트)`)
				.join('\n');
			const ok = window.confirm(
				`다음 전시회는 이미 존재합니다. 기존 전시회에 프로젝트가 추가됩니다.\n\n${names}\n\n계속하시겠습니까?`,
			);
			if (!ok) return;
		}

		executeMutation.mutate(file);
	};

	const handleReset = () => {
		setFile(null);
		setStep('select');
		setPreview(null);
		setResult(null);
		if (fileRef.current) fileRef.current.value = '';
	};

	return (
		<div className="admin-import-page">
			<div className="admin-page-header">
				<div className="admin-page-header__text">
					<span className="admin-page-header__eyebrow">Data Import</span>
					<h1>JSON 데이터 임포트</h1>
				</div>
			</div>

			<p style={{ marginBottom: '1.5rem', opacity: 0.7, fontSize: '0.9em' }}>
				JSON 파일을 업로드하여 전시회와 프로젝트 데이터를 일괄 등록합니다.
				모든 데이터는 하나의 트랜잭션으로 처리되어, 하나라도 실패하면 전체가 롤백됩니다.
			</p>

			{/* 파일 선택 영역 */}
			{step !== 'done' && (
				<div
					className="import-dropzone"
					onDrop={handleDrop}
					onDragOver={(e) => e.preventDefault()}
					onClick={() => fileRef.current?.click()}
					style={{
						border: '2px dashed var(--color-border, #555)',
						borderRadius: '8px',
						padding: '2rem',
						textAlign: 'center',
						cursor: 'pointer',
						marginBottom: '1.5rem',
						opacity: previewMutation.isPending ? 0.5 : 1,
					}}
				>
					<input
						ref={fileRef}
						type="file"
						accept=".json,application/json"
						onChange={handleFileChange}
						style={{ display: 'none' }}
					/>
					{previewMutation.isPending ? (
						<p>파일 검증 중...</p>
					) : file ? (
						<p>{file.name} ({(file.size / 1024).toFixed(1)} KB)</p>
					) : (
						<>
							<p style={{ marginBottom: '0.5rem', fontWeight: 600 }}>
								JSON 파일을 드래그하거나 클릭하여 선택
							</p>
							<p style={{ fontSize: '0.85em', opacity: 0.6 }}>최대 10MB, .json 파일만 지원</p>
						</>
					)}
				</div>
			)}

			{/* 검증 에러 */}
			{previewMutation.error && (
				<div className="error-box" role="alert" style={{ marginBottom: '1rem' }}>
					<p>{getApiErrorMessage(previewMutation.error)}</p>
				</div>
			)}

			{preview && !preview.valid && preview.errors.length > 0 && (
				<div className="error-box" role="alert" style={{ marginBottom: '1rem' }}>
					<p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>JSON 검증 실패</p>
					<ul style={{ margin: 0, paddingLeft: '1.5rem' }}>
						{preview.errors.map((err, i) => (
							<li key={i}>{err}</li>
						))}
					</ul>
				</div>
			)}

			{/* 프리뷰 결과 */}
			{step === 'preview' && preview && preview.valid && (
				<>
					<fieldset>
						<legend>임포트 미리보기</legend>

						<div style={{ marginBottom: '1rem' }}>
							<strong>전시회 ({preview.exhibitions.length}개)</strong>
							<table style={{ width: '100%', marginTop: '0.5rem', borderCollapse: 'collapse' }}>
								<thead>
									<tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border, #555)' }}>
										<th style={{ padding: '0.4rem 0.5rem' }}>연도</th>
										<th style={{ padding: '0.4rem 0.5rem' }}>제목</th>
										<th style={{ padding: '0.4rem 0.5rem' }}>상태</th>
									</tr>
								</thead>
								<tbody>
									{preview.exhibitions.map((ex, i) => (
										<tr key={i} style={{ borderBottom: '1px solid var(--color-border, #333)' }}>
											<td style={{ padding: '0.4rem 0.5rem' }}>{ex.year}</td>
											<td style={{ padding: '0.4rem 0.5rem' }}>{ex.title}</td>
											<td style={{ padding: '0.4rem 0.5rem' }}>
												{ex.isNew ? (
													<span style={{ color: 'var(--color-success, #4caf50)' }}>새로 생성</span>
												) : (
													<span style={{ color: 'var(--color-warning, #ff9800)' }}>
														기존 전시회 (프로젝트 {ex.existingProjectCount}개 보유)
													</span>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>

						<div>
							<strong>프로젝트: {preview.projectCount}개</strong> 추가 예정
						</div>
					</fieldset>

					{executeMutation.error && (
						<div className="error-box" role="alert" style={{ marginTop: '1rem' }}>
							<p>{getApiErrorMessage(executeMutation.error)}</p>
						</div>
					)}

					<div className="form-actions" style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
						<button
							className="btn btn--primary"
							onClick={handleConfirm}
							disabled={executeMutation.isPending}
						>
							{executeMutation.isPending ? '임포트 중...' : '임포트 실행'}
						</button>
						<button
							className="btn"
							onClick={handleReset}
							disabled={executeMutation.isPending}
						>
							취소
						</button>
					</div>
				</>
			)}

			{/* 완료 결과 */}
			{step === 'done' && result && (
				<>
					<div style={{
						padding: '1.5rem',
						borderRadius: '8px',
						border: '1px solid var(--color-success, #4caf50)',
						marginBottom: '1rem',
					}}>
						<p style={{ fontWeight: 600, marginBottom: '0.75rem', color: 'var(--color-success, #4caf50)' }}>
							임포트가 완료되었습니다.
						</p>
						<ul style={{ margin: 0, paddingLeft: '1.5rem' }}>
							<li>전시회: {result.exhibitions.created}개 생성, {result.exhibitions.existing}개 기존 재활용</li>
							<li>프로젝트: {result.projects.created}개 생성</li>
						</ul>
					</div>
					<button className="btn btn--primary" onClick={handleReset}>
						다른 파일 임포트
					</button>
				</>
			)}

			{/* JSON 형식 안내 */}
			<details style={{ marginTop: '2rem' }}>
				<summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: '0.5rem' }}>
					JSON 파일 형식 안내
				</summary>
				<pre style={{
					padding: '1rem',
					borderRadius: '6px',
					overflow: 'auto',
					fontSize: '0.85em',
					background: 'var(--color-surface, #1a1a1a)',
					border: '1px solid var(--color-border, #333)',
				}}>
{`{
  "years": [
    {
      "year": 2024,
      "title": "2024 졸업작품전",
      "isUploadEnabled": false
    }
  ],
  "projects": [
    {
      "year": 2024,
      "title": "게임 제목",
      "slug": "game-title",
      "summary": "한 줄 소개",
      "description": "상세 설명",
      "isLegacy": true,
      "status": "PUBLISHED",
      "githubUrl": "https://github.com/...",
      "platforms": ["PC", "WEB"],
      "members": [
        { "name": "홍길동", "studentId": "20240001" }
      ]
    }
  ]
}`}
				</pre>
			</details>
		</div>
	);
}
