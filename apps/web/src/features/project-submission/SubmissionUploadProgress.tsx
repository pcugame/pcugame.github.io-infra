import type { StudioFileGroup } from './studio/fileGroups';
import { UploadFileRows } from '../../components/common/UploadFileRows';
import { useMemo } from 'react';
import type { ProjectSubmissionItemStatus } from '../../contracts';
import GameUploadWidget from '../../components/GameUploadWidget';
import DirectVideoUploadWidget from '../../components/DirectVideoUploadWidget';
import DirectImageUploadWidget from '../../components/DirectImageUploadWidget';
import { uploadKindLabels } from '../../lib/upload/project-files';
import type { SubmissionFilesState } from './useSubmissionFiles';

export function SubmissionUploadProgress({
	zone,
	group,
	fileNames = {},
	projectId,
	files,
	items,
	onComplete,
}: {
	zone: 'poster' | 'files';
	group?: StudioFileGroup;
	fileNames?: Record<string, string>;
	projectId: number;
	files: SubmissionFilesState;
	items: ProjectSubmissionItemStatus[];
	onComplete: () => void;
}) {
	const owner = useMemo(() => ({ type: 'PROJECT' as const, id: projectId }), [projectId]);
	const posterFiles = useMemo(() => (files.posterFile ? [files.posterFile] : []), [files.posterFile]);
	const ordered = [...items].sort((left, right) =>
		left.slot.localeCompare(right.slot, undefined, { numeric: true }),
	);
	const kinds = group?.kinds ?? (
		zone === 'poster'
			? (['POSTER'] as const)
			: (['GAME', 'WEBGL', 'VIDEO', 'IMAGE', 'DOCUMENT', 'ATTACHMENT'] as const));
	if (!ordered.some(item => (kinds as readonly string[]).includes(item.kind))) return null;
	return (
				<ul
					className="project-upload-queue"
					aria-label={group ? `${group.label} 업로드 진행` : zone === 'poster' ? '포스터 업로드 진행' : '파일 업로드 진행'}
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
                                {selected.length === 0 && !kindItems.every(item => item.state === 'READY') && <UploadFileRows names={kindItems.filter(item => item.state === 'READY').map((item, index) => fileNames[item.slot] ?? `${uploadKindLabels[kind]} ${index + 1}`)} phase="ready" />}
								{/* Keep one batch owner and its absolute manifest indexes throughout status refreshes. */}
								{kindItems.every((item) => item.state === 'READY') ? (
									<UploadFileRows names={selected.length ? selected.map(file => file.name) : kindItems.map((item, index) => fileNames[item.slot] ?? `${uploadKindLabels[kind]} ${index + 1}`)} phase="ready" />
								) : kind === 'GAME' || kind === 'WEBGL' ? (
									<GameUploadWidget
                                        displayNames={pendingItems.map(item => fileNames[item.slot] ?? uploadKindLabels[kind])}
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
                                        displayNames={pendingItems.map(item => fileNames[item.slot] ?? uploadKindLabels[kind])}
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
                                        displayNames={pendingItems.map(item => fileNames[item.slot] ?? uploadKindLabels[kind])}
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
	);
}
