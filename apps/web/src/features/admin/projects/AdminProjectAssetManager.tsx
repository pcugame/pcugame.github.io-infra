import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { AdminProjectDetail } from '@pcu/contracts';
import DirectImageUploadWidget from '../../../components/DirectImageUploadWidget';
import DirectVideoUploadWidget from '../../../components/DirectVideoUploadWidget';
import GameUploadWidget from '../../../components/GameUploadWidget';
import type { ClientUploadLimits } from '../../../lib/upload-limits';
import { ProjectPosterPreview, ProjectUploadDropZone } from '../../../components/project/editor';
import { useProjectUploadQueue, type ProjectUploadQueue } from './useProjectUploadQueue';
import { uploadKindLabels, type UploadEntry, type UploadZone } from '../../../lib/upload/project-files';

const QueueContext = createContext<ProjectUploadQueue | null>(null);
export function AdminProjectUploadProvider({
	project,
	projectId,
	limits,
	canEditContent,
	children,
}: {
	project: AdminProjectDetail;
	projectId: number;
	limits: ClientUploadLimits;
	canEditContent: boolean;
	children: ReactNode;
}) {
	const queue = useProjectUploadQueue(project, projectId, limits, canEditContent);
	return <QueueContext.Provider value={queue}>{children}</QueueContext.Provider>;
}
function useQueue() {
	const queue = useContext(QueueContext);
	if (!queue) throw new Error('Project upload provider is required');
	return queue;
}
function ActiveUpload({ entry, queue }: { entry: UploadEntry; queue: ProjectUploadQueue }) {
	const files = useMemo(() => [entry.file], [entry.file]);
	const { complete, cancel } = queue;
	const onComplete = useCallback(() => {
		void complete(entry.id);
	}, [complete, entry.id]);
	const onCancelled = useCallback(() => cancel(entry.id), [cancel, entry.id]);
	const common = { autoStart: true, compact: true, onComplete, onCancelled };
	if (entry.kind === 'POSTER' || entry.kind === 'IMAGE')
		return <DirectImageUploadWidget {...common} owner={queue.owner} kind={entry.kind} initialFiles={files} />;
	if (entry.kind === 'GAME' || entry.kind === 'WEBGL')
		return (
			<GameUploadWidget
				{...common}
				projectId={queue.owner.id}
				uploadKind={entry.kind}
				initialFile={entry.file}
			/>
		);
	if (entry.kind === 'ZIP') return null;
	return (
		<DirectVideoUploadWidget
			{...common}
			projectId={queue.owner.id}
			kind={entry.kind}
			label={uploadKindLabels[entry.kind]}
			initialFiles={files}
			maxFiles={1}
			maxFileBytes={entry.kind === 'VIDEO' ? undefined : queue.materialLimits?.maxBytes}
		/>
	);
}
function UploadDropZone({
	zone,
	canEditContent,
	children,
}: {
	zone: UploadZone;
	canEditContent: boolean;
	children?: ReactNode;
}) {
	const queue = useQueue();
	const poster = zone === 'poster';
	const entries = queue.entries.filter((entry) => entry.zone === zone && entry.status !== 'cancelled');
	return (
		<ProjectUploadDropZone
			zone={zone}
			enabled={canEditContent}
			onFiles={(files) => queue.add(files, zone)}
			hint={!canEditContent ? '파일을 업로드할 권한이 없습니다.' : undefined}
			footer={
				<>
					{poster && queue.posterError && (
						<p role="alert" className="field-error">
							{queue.posterError}
						</p>
					)}
					{!poster && canEditContent && queue.configUnavailable && (
						<p className="field-hint" role="status">
							자료 업로드 설정을 불러오지 못하면 문서·첨부자료는 대기합니다.{' '}
							<button
								type="button"
								className="btn btn--secondary btn--small"
								disabled={queue.configLoading}
								onClick={queue.retryConfig}
							>
								{queue.configLoading ? '설정 조회 중…' : '설정 재시도'}
							</button>
						</p>
					)}
					{entries.length > 0 && (
						<ul
							className="project-upload-queue"
							aria-label={poster ? '포스터 업로드 대기열' : '파일 업로드 대기열'}
						>
							{entries.map((entry) => (
								<li key={entry.id}>
									<p>
										<strong>{entry.file.name}</strong> ·{' '}
										{entry.kind === 'ZIP' ? 'ZIP 용도 선택 대기' : uploadKindLabels[entry.kind]}
									</p>
									{entry.status === 'done' ? (
										<span role="status">업로드 완료</span>
									) : entry.status === 'active' ? (
										<>
											{canEditContent && <ActiveUpload entry={entry} queue={queue} />}
											{queue.refreshError && (
												<p role="alert">
													업로드 후 정보를 갱신하지 못했습니다.{' '}
													<button
														type="button"
														className="btn btn--secondary btn--small"
														onClick={() => void queue.complete(entry.id)}
													>
														조회 재시도
													</button>
												</p>
											)}
										</>
									) : (
										<>
											{entry.kind === 'ZIP' ? (
												<div className="project-upload-queue__choices">
													{(['GAME', 'WEBGL', 'ATTACHMENT'] as const).map((kind) => (
														<button
															key={kind}
															type="button"
															className="btn btn--secondary btn--small"
															disabled={!canEditContent}
															onClick={() => queue.choose(entry.id, kind)}
														>
															{uploadKindLabels[kind]}
														</button>
													))}
												</div>
											) : (
												<p role="status">{queue.issues.get(entry.id) ?? '업로드 대기 중'}</p>
											)}
											<button
												type="button"
												className="btn btn--secondary btn--small"
												onClick={() => queue.cancel(entry.id)}
											>
												취소
											</button>
										</>
									)}
								</li>
							))}
						</ul>
					)}
				</>
			}
		>
			{children}
		</ProjectUploadDropZone>
	);
}
export function AdminProjectPosterUpload({
	project,
	canEditContent,
}: {
	project: AdminProjectDetail;
	canEditContent: boolean;
}) {
	return (
		<fieldset>
			<legend>포스터</legend>
			<UploadDropZone zone="poster" canEditContent={canEditContent}>
				<ProjectPosterPreview image={project.poster} title={project.title} />
			</UploadDropZone>
		</fieldset>
	);
}
export function AdminProjectAssetManager({ canEditContent }: { canEditContent: boolean }) {
	return (
		<fieldset>
			<legend>기타 파일</legend>
			<UploadDropZone zone="files" canEditContent={canEditContent} />
		</fieldset>
	);
}
