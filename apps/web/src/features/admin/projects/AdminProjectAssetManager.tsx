import { WebglBuildGuideLink } from '../../../components/project/WebglBuildGuideLink';
import { StudioFileHeading } from '../../../components/project/editor/StudioFileHeading';
import { studioFileHint } from '../../../components/project/editor/studioFileHint';
import { UploadFileRows } from '../../../components/common/UploadFileRows';
import { ProjectFileLimits } from '../../../components/project/editor/ProjectFileLimits';
import { FormSection } from '../../../components/ui';
import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import type { AdminProjectDetail } from '@pcu/contracts';
import DirectImageUploadWidget from '../../../components/DirectImageUploadWidget';
import DirectVideoUploadWidget from '../../../components/DirectVideoUploadWidget';
import GameUploadWidget from '../../../components/GameUploadWidget';
import type { ClientUploadLimits } from '../../../lib/upload-limits';
import { ProjectPosterPreview, ProjectUploadDropZone } from '../../../components/project/editor';
import { useProjectUploadQueue, type ProjectUploadQueue } from './useProjectUploadQueue';
import { classifyProjectFile, uploadKindLabels, type ProjectUploadKind, type UploadEntry, type UploadZone } from '../../../lib/upload/project-files';
import { studioFileGroups } from '../../project-submission/studio/fileGroups';
import { formatFileSizeMb } from '../../../lib/upload/fileValidation';

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
// The provider and its consumer hook share one context.
// eslint-disable-next-line react-refresh/only-export-components
export function useAdminProjectUploadQueue() {
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
	const common = { autoStart: true, compact: true, onComplete, onCancelled, onError: queue.fail, retryAttempt: queue.retryAttempt, cancelAttempt: queue.cancelAttempt };
	if (entry.kind === 'POSTER' || entry.kind === 'IMAGE')
		return <DirectImageUploadWidget {...common} owner={queue.owner} kind={entry.kind} initialFiles={files} submissionItems={queue.submissionItem ? [queue.submissionItem] : undefined} />;
	if (entry.kind === 'GAME' || entry.kind === 'WEBGL')
		return (
			<GameUploadWidget
				{...common}
				projectId={queue.owner.id}
				uploadKind={entry.kind}
				initialFile={entry.file}
				submissionItem={queue.submissionItem}
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
			submissionItems={queue.submissionItem ? [queue.submissionItem] : undefined}
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
	const queue = useAdminProjectUploadQueue();
	const poster = zone === 'poster';
	const entries = queue.entries.filter((entry) => entry.zone === zone && entry.status !== 'cancelled');
	return (
		<ProjectUploadDropZone
			zone={zone}
			enabled={canEditContent && !queue.locked}
			onFiles={(files) => queue.add(files, zone)}
			hint={!canEditContent ? '파일을 업로드할 권한이 없습니다.' : poster ? `JPG · PNG · WebP 최대 ${queue.limits.posterMaxMb}MB / PDF 최대 ${queue.limits.posterPdfMaxMb}MB` : undefined}
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
											<span role="status">업로드 진행 중</span>

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
															disabled={!canEditContent || queue.locked}
															onClick={() => queue.choose(entry.id, kind)}
														>
															{uploadKindLabels[kind]}
														</button>
													))}
												</div>
											) : (
												<p role="status">{queue.issues.get(entry.id) ?? '적용 시 업로드' }</p>
											)}
											<button
												type="button"
												className="btn btn--secondary btn--small"
												disabled={!canEditContent || queue.locked}
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
function StoredFiles({ poster, canEditContent }: { poster: boolean; canEditContent: boolean }) {
	const queue = useAdminProjectUploadQueue();
	const assets = queue.storedAssets.filter((asset) => poster
		? asset.id === queue.project.posterAssetId || asset.kind === 'POSTER'
		: asset.id !== queue.project.posterAssetId && asset.kind !== 'POSTER');
	if (!assets.length && (poster || !queue.hasWebgl)) return null;
	return <ul className="project-upload-queue" aria-label={poster ? '등록된 포스터' : '등록된 파일'}>
		{assets.map((asset) => <li key={asset.id}>
			<span><strong>{asset.originalName}</strong> · {asset.kind === 'THUMBNAIL' ? '썸네일' : uploadKindLabels[asset.kind]}{queue.removals.includes(asset.id) && ' · 삭제 예정'}</span>{' '}
			{canEditContent && <button type="button" className="btn btn--secondary btn--small"
				disabled={queue.locked} onClick={() => queue.toggleRemoval(asset.id)}>
				{queue.removals.includes(asset.id) ? '삭제 취소' : '삭제'}
			</button>}
		</li>)}
		{!poster && queue.hasWebgl && <li><span>WebGL 배포{queue.removeWebgl && ' · 삭제 예정'}</span>{' '}
			{canEditContent && <button type="button" className="btn btn--secondary btn--small"
				disabled={queue.locked} onClick={queue.toggleWebglRemoval}>
				{queue.removeWebgl ? '삭제 취소' : '삭제'}
			</button>}
		</li>}
	</ul>;
}
export function AdminProjectPosterUpload({
	project,
	canEditContent,
	studio = false,
}: {
	project: AdminProjectDetail;
	canEditContent: boolean;
	studio?: boolean;
}) {
	const queue = useAdminProjectUploadQueue();
	if (studio) return <StudioEditFileArea label="포스터" kinds={['POSTER']} canEditContent={canEditContent} />;
	const selected = queue.entries.filter(entry => entry.kind === 'POSTER' && (entry.status === 'pending' || entry.status === 'active')).at(-1)?.file;
	return (
		<FormSection legend="포스터">
			<StoredFiles poster canEditContent={canEditContent} />
			<UploadDropZone zone="poster" canEditContent={canEditContent}>
				<ProjectPosterPreview image={project.poster} title={project.title} localFile={selected} />
			</UploadDropZone>
		</FormSection>
	);
}
export function AdminProjectAssetManager({ canEditContent, studio = false }: { canEditContent: boolean; studio?: boolean }) {
	const queue = useAdminProjectUploadQueue();
	return (
		studio ? <div className="studio-files-container"><div className="studio-files-grid">{studioFileGroups.map(group => <StudioEditFileArea key={group.id} label={group.label} kinds={[...group.kinds]} canEditContent={canEditContent} />)}</div></div> : <fieldset className="form-section">
			<legend className="submission-file-heading"><span>게임·미디어·자료</span><WebglBuildGuideLink /></legend>
			<StoredFiles poster={false} canEditContent={canEditContent} />
			<UploadDropZone zone="files" canEditContent={canEditContent} />
			<ProjectFileLimits limits={queue.limits} materialLimits={queue.materialLimits} />
		</fieldset>
	);
}

function StudioEditFileArea({ label, kinds, canEditContent }: { label: string; kinds: ProjectUploadKind[]; canEditContent: boolean }) {
 const queue = useAdminProjectUploadQueue();
 const id = useId();
 const [error, setError] = useState<string | null>(null);
 const poster = kinds.includes('POSTER'), build = kinds.includes('GAME') || kinds.includes('WEBGL'), video = kinds.includes('VIDEO');
 const entries = queue.entries.filter(entry => entry.kind !== 'ZIP' && kinds.includes(entry.kind) && entry.status !== 'cancelled');
 const stored = queue.storedAssets.filter(asset => poster ? asset.id === queue.project.posterAssetId : asset.id !== queue.project.posterAssetId && kinds.includes(asset.kind as ProjectUploadKind));
 const hint = studioFileHint(poster ? 'POSTER' : kinds.includes('WEBGL') ? 'WEBGL' : build ? 'GAME' : video ? 'VIDEO' : 'IMAGE', queue.limits, queue.materialLimits);
 const select = (files: File[]) => {
  if (!files.length) return;
  if ((poster || build) && files.length !== 1) { setError('파일 한 개만 선택하세요.'); return; }
  const typed: ProjectUploadKind[] = [];
  for (const file of files) {
   const type = classifyProjectFile(file, poster ? 'poster' : 'files');
   if (poster && type !== 'POSTER') { setError('포스터는 JPG·PNG·WebP·PDF 파일만 선택하세요.'); return; }
   if (build && type !== 'ZIP') { setError('빌드는 ZIP 파일만 선택하세요.'); return; }
   if (video && type !== 'VIDEO') { setError('지원하는 동영상 파일만 선택하세요.'); return; }
   if (!poster && !build && !video && (type === 'VIDEO' || file.type.startsWith('video/'))) { setError('영상은 동영상 영역에서 선택하세요.'); return; }
   typed.push(poster ? 'POSTER' : build ? kinds[0] : type === 'IMAGE' || type === 'DOCUMENT' || type === 'VIDEO' ? type : 'ATTACHMENT');
  }
  setError(queue.add(files, poster ? 'poster' : 'files', typed));
 };
 return <fieldset className="form-section submission-file-fieldset" aria-labelledby={`${id}-title`}>
  <StudioFileHeading id={id} label={label} hint={hint} error={error} poster={poster} webgl={kinds.includes('WEBGL')} />
  <ProjectUploadDropZone zone={poster ? 'poster' : 'files'} compact label={`${label} 파일 선택`} enabled={canEditContent && !queue.locked} multiple={!poster && !build} accept={build ? '.zip,application/zip' : poster ? undefined : video ? 'video/*' : undefined} onFiles={select} footer={<div className="studio-files-scroll" tabIndex={0} aria-label={`${label} 파일 목록`}>
   {!poster && !build && !video && queue.configUnavailable && <p className="field-hint">자료 설정을 불러오지 못했습니다. <button type="button" className="btn btn--secondary btn--small" disabled={queue.configLoading || queue.locked} onClick={queue.retryConfig}>설정 재시도</button></p>}
   <ul className="project-upload-queue">
    {stored.map(asset => <li key={`stored-${asset.id}`}><p title={asset.originalName}><strong>{asset.originalName}</strong>{queue.removals.includes(asset.id) && ' · 삭제 예정'}</p>{canEditContent && <button type="button" className="btn btn--secondary btn--small" disabled={queue.locked} onClick={() => queue.toggleRemoval(asset.id)}>{queue.removals.includes(asset.id) ? '삭제 취소' : '삭제'}</button>}</li>)}
    {kinds.includes('WEBGL') && queue.hasWebgl && <li><p>WebGL 배포{queue.removeWebgl && ' · 삭제 예정'}</p>{canEditContent && <button type="button" className="btn btn--secondary btn--small" disabled={queue.locked} onClick={queue.toggleWebglRemoval}>{queue.removeWebgl ? '삭제 취소' : '삭제'}</button>}</li>}
    {entries.map(entry => <li key={entry.id}><p title={entry.file.name}><strong>{entry.file.name}</strong> · {formatFileSizeMb(entry.file.size)}MB{entry.status === 'done' && ' · 업로드 완료'}</p>{entry.status === 'active' ? <span role="status">업로드 진행 중</span> : entry.status === 'pending' && <button type="button" className="btn btn--secondary btn--small" disabled={queue.locked} onClick={() => queue.cancel(entry.id)}>선택 취소</button>}</li>)}
   </ul>
  </div>} />
 </fieldset>;
}

/** Mounted once for the whole editor, including retries after partial failure. */
export function AdminProjectUploadProgress() {
 const queue = useAdminProjectUploadQueue();
 return <ul className="project-upload-queue" aria-label="변경 파일 업로드 진행">
  {queue.entries.filter(entry => entry.status !== 'cancelled').map(entry => <li key={entry.id}>
   {entry.status === 'active' ? <ActiveUpload entry={entry} queue={queue} /> : <UploadFileRows names={[entry.file.name]} phase={entry.status === 'done' ? 'ready' : 'idle'} />}
  </li>)}
 </ul>;
}
