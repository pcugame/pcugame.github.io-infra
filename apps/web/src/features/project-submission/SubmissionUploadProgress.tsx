import { useMemo } from 'react';
import type { ProjectSubmissionItemStatus } from '../../contracts';
import GameUploadWidget from '../../components/GameUploadWidget';
import DirectVideoUploadWidget from '../../components/DirectVideoUploadWidget';
import DirectImageUploadWidget from '../../components/DirectImageUploadWidget';
import { ProjectPosterPreview } from '../../components/project/editor/ProjectPosterPreview';
import { uploadKindLabels } from '../../lib/upload/project-files';
import type { SubmissionFilesState } from './useSubmissionFiles';

export function SubmissionUploadProgress({
	zone,
	projectId,
	files,
	items,
	onComplete,
	title = '작품',
}: {
	zone: 'poster' | 'files';
	projectId: number;
	files: SubmissionFilesState;
	items: ProjectSubmissionItemStatus[];
	onComplete: () => void;
	title?: string;
}) {
	const owner = useMemo(() => ({ type: 'PROJECT' as const, id: projectId }), [projectId]);
	const posterFiles = useMemo(() => (files.posterFile ? [files.posterFile] : []), [files.posterFile]);
	const ordered = [...items].sort((left, right) =>
		left.slot.localeCompare(right.slot, undefined, { numeric: true }),
	);
	const kinds =
		zone === 'poster'
			? (['POSTER'] as const)
			: (['GAME', 'WEBGL', 'VIDEO', 'IMAGE', 'DOCUMENT', 'ATTACHMENT'] as const);
	return (
		<fieldset>
			<legend>{zone === 'poster' ? '포스터' : '기타 파일'}</legend>
			{zone === 'poster' && <ProjectPosterPreview title={title} localFile={files.posterFile} />}
			{!ordered.some((item) => (zone === 'poster' ? item.kind === 'POSTER' : item.kind !== 'POSTER')) ? (
				<p className="field-hint">
					{zone === 'poster' ? '포스터' : '파일'} 업로드가 완료되었거나 선택한 파일이 없습니다.
				</p>
			) : (
				<ul
					className="project-upload-queue"
					aria-label={zone === 'poster' ? '포스터 업로드 진행' : '파일 업로드 진행'}
				>
					{kinds.map((kind) => {
						const kindItems = ordered.filter((item) => item.kind === kind);
						if (kindItems.length === 0) return null;
						const initialFiles =
							kind === 'POSTER'
								? posterFiles
								: kind === 'IMAGE'
									? files.imageFiles
									: kind === 'VIDEO'
										? files.videoFiles
										: kind === 'DOCUMENT'
											? files.documentFiles
											: files.attachmentFiles;
						const initialFile = kind === 'GAME' ? files.gameFile : files.webglFile;
						const selected =
							kind === 'GAME' || kind === 'WEBGL' ? (initialFile ? [initialFile] : []) : initialFiles;
						// Bound batches retain absolute file indexes. Reloaded batches advance to remaining slots.
						const pendingItems = selected.length
							? kindItems
							: kindItems.filter((item) => item.state !== 'READY');
						const binding = pendingItems.map((item) => ({ id: item.id, clientToken: item.clientToken }));
						return (
							<li key={`${kind}:${pendingItems.map((item) => item.id).join(':')}`}>
								<p>
									<strong>
										{selected.length > 0
											? selected.map((file) => file.name).join(', ')
											: uploadKindLabels[kind]}
									</strong>{' '}
									· {uploadKindLabels[kind]}
								</p>
								{/* Keep one batch owner and its absolute manifest indexes throughout status refreshes. */}
								{kindItems.every((item) => item.state === 'READY') ? (
									<p role="status">업로드 완료</p>
								) : kind === 'GAME' || kind === 'WEBGL' ? (
									<GameUploadWidget
										projectId={projectId}
										uploadKind={kind}
										initialFile={initialFile}
										autoStart={Boolean(initialFile)}
										compact={Boolean(initialFile)}
										submissionItem={binding[0]}
										onComplete={onComplete}
									/>
								) : kind === 'POSTER' || kind === 'IMAGE' ? (
									<DirectImageUploadWidget
										owner={owner}
										kind={kind}
										initialFiles={initialFiles}
										autoStart={initialFiles.length > 0}
										compact={initialFiles.length > 0}
										submissionItems={binding}
										onComplete={onComplete}
									/>
								) : (
									<DirectVideoUploadWidget
										projectId={projectId}
										kind={kind}
										label={uploadKindLabels[kind]}
										initialFiles={initialFiles}
										accept={
											kind === 'DOCUMENT'
												? 'text/plain,text/markdown,application/pdf,.txt,.md,.markdown,.pdf,.doc,.docx,.odt,.ods,.odp,.rtf,.xls,.xlsx,.ppt,.pptx'
												: undefined
										}
										autoStart={initialFiles.length > 0}
										compact={initialFiles.length > 0}
										submissionItems={binding}
										onComplete={onComplete}
									/>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</fieldset>
	);
}
