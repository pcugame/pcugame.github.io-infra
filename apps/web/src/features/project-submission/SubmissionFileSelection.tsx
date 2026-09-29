import { useEffect, useRef, useState } from 'react';
import { ProjectPosterPreview } from '../../components/project/editor/ProjectPosterPreview';
import { ProjectUploadDropZone } from '../../components/project/editor/ProjectUploadDropZone';
import {
	classifyProjectFile,
	uploadKindLabels,
	type ProjectUploadKind,
} from '../../lib/upload/project-files';
import type { ClientUploadLimits, MaterialUploadLimits } from '../../lib/upload-limits';
import type { SubmissionFilesState } from './useSubmissionFiles';

export function SubmissionPosterSelection({
	files,
	enabled,
	title,
	limits,
}: {
	files: SubmissionFilesState;
	enabled: boolean;
	title: string;
	limits: ClientUploadLimits;
}) {
	const [selectionError, setSelectionError] = useState<string | null>(null);
	return (
		<fieldset>
			<legend>포스터</legend>
			<ProjectUploadDropZone
				zone="poster"
				enabled={enabled}
				hint={`JPG · PNG · WebP 최대 ${limits.posterMaxMb}MB / PDF 최대 ${limits.posterPdfMaxMb}MB. 등록·제출 후 업로드됩니다.`}
				onFiles={(selected) => {
					if (selected.length !== 1 || classifyProjectFile(selected[0]!, 'poster') !== 'POSTER') {
						setSelectionError('포스터는 JPG · PNG · WebP · PDF 파일 한 개를 선택하세요.');
						return;
					}
					setSelectionError(null);
					files.selectPoster(selected[0]!);
				}}
				footer={
					<>
						{selectionError && (
							<p className="field-error" role="alert">
								{selectionError}
							</p>
						)}
						{files.posterFile && (
							<ul className="project-upload-queue" aria-label="선택한 포스터">
								<li>
									<p>
										<strong>{files.posterFile.name}</strong> · 포스터
									</p>
									<button
										type="button"
										className="btn btn--secondary btn--small"
										disabled={!enabled}
										onClick={files.clearPoster}
									>
										선택 취소
									</button>
								</li>
							</ul>
						)}
					</>
				}
			>
				<ProjectPosterPreview title={title} localFile={files.posterFile} />
			</ProjectUploadDropZone>
		</fieldset>
	);
}

export function SubmissionMixedFilesSelection({
	files,
	enabled,
	onPendingZipChange,
	limits,
	materialLimits,
	webglUploadHint,
}: {
	files: SubmissionFilesState;
	enabled: boolean;
	onPendingZipChange: (count: number) => void;
	limits: ClientUploadLimits;
	materialLimits?: MaterialUploadLimits;
	webglUploadHint: string;
}) {
	const [zipFiles, setZipFiles] = useState<{ id: number; file: File }[]>([]);
	const nextId = useRef(0);
	useEffect(() => {
		onPendingZipChange(zipFiles.length);
	}, [onPendingZipChange, zipFiles.length]);
	const selected: { kind: ProjectUploadKind; file: File }[] = [
		...(files.gameFile ? [{ kind: 'GAME' as const, file: files.gameFile }] : []),
		...(files.webglFile ? [{ kind: 'WEBGL' as const, file: files.webglFile }] : []),
		...files.imageFiles.map((file) => ({ kind: 'IMAGE' as const, file })),
		...files.videoFiles.map((file) => ({ kind: 'VIDEO' as const, file })),
		...files.documentFiles.map((file) => ({ kind: 'DOCUMENT' as const, file })),
		...files.attachmentFiles.map((file) => ({ kind: 'ATTACHMENT' as const, file })),
	];
	return (
		<fieldset>
			<legend>기타 파일</legend>
			<ProjectUploadDropZone
				zone="files"
				enabled={enabled}
				hint="파일을 선택하면 목록에 보관됩니다. 작품 등록·제출을 눌러야 업로드가 시작됩니다. ZIP은 용도를 선택하세요."
				onFiles={(chosen) => {
					const typed: { kind: Exclude<ProjectUploadKind, 'POSTER'>; file: File }[] = [];
					const zips: File[] = [];
					for (const file of chosen) {
						const kind = classifyProjectFile(file, 'files');
						if (kind === 'ZIP') zips.push(file);
						else if (kind && kind !== 'POSTER') typed.push({ kind, file });
					}
					if (typed.length > 0 && !files.addFiles(typed)) return;
					setZipFiles((previous) => [...previous, ...zips.map((file) => ({ id: ++nextId.current, file }))]);
				}}
				footer={
					<>
						{(selected.length > 0 || zipFiles.length > 0) && (
							<ul className="project-upload-queue" aria-label="선택한 파일">
								{selected.map(({ kind, file }, index) => (
									<li key={`${kind}:${index}`}>
										<p>
											<strong>{file.name}</strong> · {uploadKindLabels[kind]}
										</p>
										<p role="status">등록·제출 후 업로드 대기</p>
										<button
											type="button"
											className="btn btn--secondary btn--small"
											disabled={!enabled}
											onClick={() => files.removeFile(kind, file)}
										>
											선택 취소
										</button>
									</li>
								))}
								{zipFiles.map(({ id, file }) => (
									<li key={`zip:${id}`}>
										<p>
											<strong>{file.name}</strong> · ZIP 용도 선택 대기
										</p>
										<div className="project-upload-queue__choices">
											{(['GAME', 'WEBGL', 'ATTACHMENT'] as const).map((kind) => (
												<button
													key={kind}
													type="button"
													className="btn btn--secondary btn--small"
													disabled={!enabled}
													onClick={() => {
														if (files.addFiles([{ kind, file }]))
															setZipFiles((previous) => previous.filter((entry) => entry.id !== id));
													}}
												>
													{uploadKindLabels[kind]}
												</button>
											))}
										</div>
										<button
											type="button"
											className="btn btn--secondary btn--small"
											disabled={!enabled}
											onClick={() => setZipFiles((previous) => previous.filter((entry) => entry.id !== id))}
										>
											선택 취소
										</button>
									</li>
								))}
							</ul>
						)}
						{zipFiles.length > 0 && (
							<p className="field-hint">ZIP 용도를 선택하거나 선택을 취소한 뒤 등록·제출하세요.</p>
						)}
						<p className="field-hint">
							이미지 파일당 {limits.imageMaxMb}MB · 동영상 파일당 {limits.videoMaxMb}MB, 최대 5개 · 게임·WebGL
							ZIP {limits.gameMaxMb}MB
						</p>
						{materialLimits && (
							<p className="field-hint">
								문서·첨부자료는 합쳐 최대 {materialLimits.maxCount}개, 파일당{' '}
								{(materialLimits.maxBytes / 1024 / 1024).toFixed(0)}MB
							</p>
						)}
						<p className="field-hint">{webglUploadHint}</p>
					</>
				}
			/>
		</fieldset>
	);
}
