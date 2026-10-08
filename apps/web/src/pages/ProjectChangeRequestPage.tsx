import { SelectControl } from '../components/ui';
import { ProjectFileLimits } from '../components/project/editor/ProjectFileLimits';
import { ProjectRequirementsFieldset } from '../components/project/ProjectRequirementsFieldset';
import { ExternalLinksSchema, HardwareRequirementsSchema, PlatformsSchema } from '@pcu/contracts';
import { ExternalLinksFieldset } from '../components/project/ExternalLinksFieldset';
import { WebglBuildGuideLink } from '../components/project/WebglBuildGuideLink';
import { effectiveExternalLinks } from '../components/project/externalLinks';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectChangeManifestItem } from '@pcu/contracts';

import DirectImageUploadWidget from '../components/DirectImageUploadWidget';
import DirectVideoUploadWidget from '../components/DirectVideoUploadWidget';
import GameUploadWidget from '../components/GameUploadWidget';
import {
	ProjectEditorLayout,
	ProjectPosterPreview,
	ProjectUploadDropZone,
} from '../components/project/editor';
import { ErrorMessage, LoadingSpinner } from '../components/common';
import { useMe } from '../features/auth';
import {
	adminProjectApi,
	changeRequestApi,
	getApiErrorMessage,
	publicApi,
	type ChangeRequestChanges,
	type ChangeRequestKind,
} from '../lib/api';
import { materialUploadLimitsFromConfig, getClientUploadLimits } from '../lib/upload-limits';
import {
	classifyProjectFile,
	isPdf,
	uploadKindLabels,
	type ProjectUploadKind,
} from '../lib/upload/project-files';
import { queryKeys } from '../lib/query';

const stateLabel: Record<string, string> = {
	DRAFT: '작성 중',
	PENDING: '검토 대기',
	APPLYING: '반영 중',
	COMPLETED: '완료',
	REJECTED: '반려',
	CANCELLED: '취소',
	CONFLICT: '충돌',
	FAILED: '반영 실패',
};
type ChangeRequestMember = { name: string; studentId: string };
type UploadFiles = Record<ProjectChangeManifestItem['kind'], File[]>;
type PendingZip = { id: string; file: File };
const emptyUploadFiles = (): UploadFiles => ({
	POSTER: [],
	IMAGE: [],
	VIDEO: [],
	DOCUMENT: [],
	ATTACHMENT: [],
	GAME: [],
	WEBGL: [],
});
const materialKinds = new Set(['DOCUMENT', 'ATTACHMENT']);

function makeUploadManifest(files: UploadFiles): {
	manifest: ProjectChangeManifestItem[];
	files: Array<{ kind: ProjectChangeManifestItem['kind']; file: File }>;
} {
	const slotFor = (kind: ProjectChangeManifestItem['kind'], index: number) =>
		kind === 'GAME'
			? 'game'
			: kind === 'WEBGL'
				? 'webgl'
				: kind === 'POSTER'
					? 'poster'
					: `${kind.toLowerCase()}:${index}`;
	const uploads = (Object.entries(files) as Array<[ProjectChangeManifestItem['kind'], File[]]>).flatMap(
		([kind, selected]) =>
			selected.map((file, index) => ({
				kind,
				file,
				slot: slotFor(kind, index),
				clientToken: crypto.randomUUID().replaceAll('-', ''),
			})),
	);
	return {
		files: uploads.map(({ kind, file }) => ({ kind, file })),
		manifest: uploads.map(({ kind, slot, clientToken }) => ({
			kind,
			slot,
			clientToken,
		})),
	};
}

const fileSizeLabel = (file: File) => `${(file.size / 1024 / 1024).toFixed(1)}MB`;

export default function ProjectChangeRequestPage() {
	const { id: rawId } = useParams<{ id: string }>();
	const projectId = Number(rawId);
	const { user } = useMe();
	const queryClient = useQueryClient();
	const projectQuery = useQuery({
		queryKey: queryKeys.adminProject(projectId),
		queryFn: () => adminProjectApi.getDetail(projectId),
		enabled: Number.isFinite(projectId),
	});
	const requestsQuery = useQuery({
		queryKey: queryKeys.projectChangeRequests(projectId),
		queryFn: () => changeRequestApi.listForProject(projectId),
		enabled: Number.isFinite(projectId),
	});
	const activeSummary = requestsQuery.data?.items.find(
		(request) =>
			request.state === 'DRAFT' ||
			request.state === 'PENDING' ||
			request.state === 'APPLYING' ||
			request.state === 'FAILED',
	);
	const activeDetailQuery = useQuery({
		queryKey: queryKeys.changeRequest(activeSummary?.id ?? ''),
		queryFn: () => changeRequestApi.get(activeSummary!.id),
		enabled: Boolean(activeSummary),
		refetchInterval: (query) => {
			const request = query.state.data;
			return request?.state === 'APPLYING' ||
				(request?.state === 'DRAFT' && request.items.some((item) => item.state !== 'READY'))
				? 1500
				: false;
		},
	});
	const uploadConfigQuery = useQuery({
		queryKey: ['public-upload-config'],
		queryFn: publicApi.getUploadConfig,
	});
	const active = activeDetailQuery.data;
	const [kind, setKind] = useState<ChangeRequestKind>('EDIT');
	const [reason, setReason] = useState<string | null>(null);
	const [changes, setChanges] = useState<ChangeRequestChanges>({});
	const [members, setMembers] = useState<ChangeRequestMember[]>([]);
	const [membersTouched, setMembersTouched] = useState(false);
	const [uploadFiles, setUploadFiles] = useState<UploadFiles>(emptyUploadFiles);
	const [uploadManifest, setUploadManifest] = useState<ProjectChangeManifestItem[] | null>(null);
	const [pendingZips, setPendingZips] = useState<PendingZip[]>([]);
	const [fileError, setFileError] = useState<string | null>(null);

	const invalidate = () => {
		void queryClient.invalidateQueries({
			queryKey: queryKeys.projectChangeRequests(projectId),
		});
		void queryClient.invalidateQueries({ queryKey: queryKeys.changeRequests });
	};
	const create = useMutation({
		mutationFn: () => changeRequestApi.create(projectId, { kind, reason: reason ?? '' }),
		onSuccess: invalidate,
	});
	const project = projectQuery.data;
	const initialChanges: ChangeRequestChanges = {
		...(project
			? {
					title: project.title,
					summary: project.summary ?? '',
					description: project.description ?? '',
					externalLinks: effectiveExternalLinks(project.externalLinks, project.githubUrl),
					platforms: [...project.platforms],
					hardwareRequirements: project.hardwareRequirements ?? '',
					posterAssetId: project.posterAssetId ?? null,
				}
			: {}),
		...(active?.changes ?? {}),
		...(active?.changes.externalLinks === undefined && active?.changes.githubUrl !== undefined ? { externalLinks: effectiveExternalLinks(undefined, active.changes.githubUrl) } : {}),
	};
	const formChanges = { ...initialChanges, ...changes };
	const formLinks = effectiveExternalLinks(formChanges.externalLinks, formChanges.githubUrl);
	const validateRequirements = () => ({
		platforms: PlatformsSchema.parse(formChanges.platforms ?? []),
		hardwareRequirements: HardwareRequirementsSchema.parse(formChanges.hardwareRequirements ?? ''),
	});
	const validateLinks = () => {
		const result = ExternalLinksSchema.safeParse(formLinks);
		if (!result.success) throw new Error(result.error.issues.map((issue) => issue.message).join(' · '));
		return result.data;
	};
	const formMembers = membersTouched
		? members
		: (initialChanges.members ?? project?.members.map(({ name, studentId }) => ({ name, studentId })) ?? []);
	const formReason = reason ?? active?.reason ?? '';
	const videoAssetIds = formChanges.videoAssetIds ?? project?.videos.map((video) => video.assetId) ?? [];
	const stagedPoster = active?.stagedAssets.find((asset) => asset.kind === 'POSTER');
	const selectedPosterId = formChanges.posterAssetId ?? null;
	const effectivePosterId =
		stagedPoster && selectedPosterId === (project?.posterAssetId ?? null)
			? stagedPoster.id
			: (formChanges.removeAssetIds ?? []).includes(selectedPosterId ?? -1)
				? null
				: selectedPosterId;
	const effectiveVideoAssetIds = [
		...new Set(
			videoAssetIds
				.filter((assetId) => !(formChanges.removeAssetIds ?? []).includes(assetId))
				.concat(
					(active?.stagedAssets ?? []).filter((asset) => asset.kind === 'VIDEO').map((asset) => asset.id),
				),
		),
	];
	const save = useMutation({
		mutationFn: () =>
			active
				? changeRequestApi.update(active.id, {
						reason: formReason,
						changes:
							active.kind === 'EDIT'
								? {
										...formChanges,
										...validateRequirements(),
										externalLinks: validateLinks(),
										members: formMembers,
										posterAssetId: effectivePosterId,
										videoAssetIds: effectiveVideoAssetIds,
									}
								: undefined,
					})
				: Promise.reject(new Error('작성 중인 요청이 없습니다.')),
		onSuccess: invalidate,
	});
	const prepareUploads = useMutation({
		mutationFn: (manifest: ProjectChangeManifestItem[]) =>
			active
				? changeRequestApi.update(active.id, { manifest })
				: Promise.reject(new Error('작성 중인 요청이 없습니다.')),
		onSuccess: (detail, manifest) => {
			queryClient.setQueryData(queryKeys.changeRequest(detail.id), detail);
			setUploadManifest(manifest);
			invalidate();
		},
	});
	const submit = useMutation({
		mutationFn: async () => {
			if (!active) throw new Error('작성 중인 요청이 없습니다.');
			if (active.kind === 'EDIT')
				await changeRequestApi.update(active.id, {
					reason: formReason,
					changes: {
						...formChanges,
						...validateRequirements(),
						externalLinks: validateLinks(),
						members: formMembers,
						posterAssetId: effectivePosterId,
						videoAssetIds: effectiveVideoAssetIds,
					},
				});
			else await changeRequestApi.update(active.id, { reason: formReason });
			return changeRequestApi.submit(active.id);
		},
		onSuccess: invalidate,
	});
	const cancel = useMutation({
		mutationFn: () =>
			active ? changeRequestApi.cancel(active.id) : Promise.reject(new Error('작성 중인 요청이 없습니다.')),
		onSuccess: invalidate,
	});

	if (projectQuery.isLoading || requestsQuery.isLoading || (activeSummary && activeDetailQuery.isLoading))
		return <LoadingSpinner />;
	if (projectQuery.error && !project)
		return <ErrorMessage error={projectQuery.error} onReset={() => projectQuery.refetch()} />;
	if (requestsQuery.error && !requestsQuery.data)
		return <ErrorMessage error={requestsQuery.error} onReset={() => requestsQuery.refetch()} />;
	if (activeDetailQuery.error && !active)
		return <ErrorMessage error={activeDetailQuery.error} onReset={() => activeDetailQuery.refetch()} />;
	if (!project) return null;
	const editable = active?.state === 'DRAFT' && active.actorId === user?.id;
	const busy =
		create.isPending || save.isPending || prepareUploads.isPending || submit.isPending || cancel.isPending;
	const mutationError = create.error ?? save.error ?? prepareUploads.error ?? submit.error ?? cancel.error;
	const uploadItemsByToken = new Map((active?.items ?? []).map((item) => [item.clientToken, item]));
	const uploadsReady = active
		? active.items.every(
				(item) => item.state === 'READY' && (item.kind !== 'VIDEO' || item.playbackState === 'READY'),
			)
		: true;
	const preparedManifest =
		uploadManifest ??
		(active?.items.length
			? active.items.map(({ kind: itemKind, slot, clientToken }) => ({
					kind: itemKind,
					slot,
					clientToken,
				}))
			: null);
	const limits = getClientUploadLimits(user?.role ?? 'USER');
	const materialLimits = materialUploadLimitsFromConfig(uploadConfigQuery.data);
	const removedAssetIds = new Set(formChanges.removeAssetIds ?? []);
	const retainedAssets = project.assets.filter((asset) => !removedAssetIds.has(asset.id));
	const existingVideoCount = new Set([
		...project.videos.filter((video) => !removedAssetIds.has(video.assetId)).map((video) => video.assetId),
		...retainedAssets.filter((asset) => asset.kind === 'VIDEO').map((asset) => asset.id),
		...(active?.stagedAssets ?? []).filter((asset) => asset.kind === 'VIDEO').map((asset) => asset.id),
	]).size;
	const existingMaterialCount = new Set([
		...(project.attachments ?? [])
			.filter((asset) => !removedAssetIds.has(asset.assetId))
			.map((asset) => asset.assetId),
		...retainedAssets.filter((asset) => materialKinds.has(asset.kind)).map((asset) => asset.id),
		...(active?.stagedAssets ?? []).filter((asset) => materialKinds.has(asset.kind)).map((asset) => asset.id),
	]).size;

	const toggleAssetRemoval = (assetId: number) => {
		const removeAssetIds = new Set(formChanges.removeAssetIds ?? []);
		if (removeAssetIds.has(assetId)) removeAssetIds.delete(assetId);
		else removeAssetIds.add(assetId);
		setChanges({ ...changes, removeAssetIds: [...removeAssetIds] });
	};
	const moveVideo = (assetId: number, direction: -1 | 1) => {
		const index = videoAssetIds.indexOf(assetId);
		const target = index + direction;
		if (index < 0 || target < 0 || target >= videoAssetIds.length) return;
		const next = [...videoAssetIds];
		[next[index], next[target]] = [next[target]!, next[index]!];
		setChanges({ ...changes, videoAssetIds: next });
	};
	const selectedFileCount = (files: UploadFiles) =>
		Object.values(files).reduce((count, selected) => count + selected.length, 0) + pendingZips.length;
	const validateFile = (
		file: File,
		uploadKind: ProjectUploadKind,
		files: UploadFiles,
		alreadyReserved = false,
	): string | null => {
		if (file.size <= 0) return `${file.name}: 빈 파일은 업로드할 수 없습니다.`;
		if (selectedFileCount(files) - (alreadyReserved ? 1 : 0) >= limits.maxFiles)
			return `한 번에 최대 ${limits.maxFiles}개 파일까지 준비할 수 있습니다.`;
		if (uploadKind === 'POSTER' && files.POSTER.length > 0) return '포스터는 한 개만 선택할 수 있습니다.';
		if ((uploadKind === 'GAME' || uploadKind === 'WEBGL') && files[uploadKind].length > 0)
			return `${uploadKindLabels[uploadKind]} ZIP은 한 개만 선택할 수 있습니다.`;
		if (uploadKind === 'VIDEO' && existingVideoCount + files.VIDEO.length >= 5)
			return '동영상은 삭제하지 않는 기존 파일과 새 파일을 합쳐 최대 5개까지 등록할 수 있습니다.';
		if (materialKinds.has(uploadKind)) {
			if (!materialLimits) return '자료 업로드 설정을 확인할 수 없어 문서와 첨부자료를 추가할 수 없습니다.';
			if (existingMaterialCount + files.DOCUMENT.length + files.ATTACHMENT.length >= materialLimits.maxCount)
				return `문서와 첨부자료는 삭제하지 않는 기존 파일과 새 파일을 합쳐 최대 ${materialLimits.maxCount}개까지 등록할 수 있습니다.`;
			if (file.size > materialLimits.maxBytes)
				return `${file.name}: 파일당 최대 ${(materialLimits.maxBytes / 1024 / 1024).toFixed(0)}MB까지 업로드할 수 있습니다.`;
			return null;
		}
		const maxMb =
			uploadKind === 'VIDEO'
				? limits.videoMaxMb
				: uploadKind === 'POSTER'
					? isPdf(file)
						? limits.posterPdfMaxMb
						: limits.posterMaxMb
					: uploadKind === 'IMAGE'
						? isPdf(file)
							? limits.imagePdfMaxMb
							: limits.imageMaxMb
						: limits.gameMaxMb;
		return file.size > maxMb * 1024 * 1024
			? `${file.name}: 파일당 최대 ${maxMb}MB까지 업로드할 수 있습니다.`
			: null;
	};
	const addFiles = (files: File[], zone: 'poster' | 'files') => {
		if (zone === 'poster' && files.length > 1) {
			setFileError('포스터는 한 개만 선택할 수 있습니다. 한 파일만 다시 선택해 주세요.');
			return;
		}
		let nextFiles = uploadFiles;
		let nextPendingZipCount = pendingZips.length;
		let changed = false;
		for (const file of files) {
			const nextCount =
				Object.values(nextFiles).reduce((count, selected) => count + selected.length, 0) +
				nextPendingZipCount;
			if (nextCount >= limits.maxFiles) {
				setFileError(`한 번에 최대 ${limits.maxFiles}개 파일까지 준비할 수 있습니다.`);
				continue;
			}
			const classified = classifyProjectFile(file, zone);
			if (!classified) {
				setFileError(`${file.name}: 이 파일은 포스터로 올릴 수 없습니다.`);
				continue;
			}
			if (classified === 'ZIP') {
				setPendingZips((previous) => [...previous, { id: crypto.randomUUID(), file }]);
				nextPendingZipCount++;
				setFileError(null);
				continue;
			}
			const issue = validateFile(file, classified, nextFiles);
			if (issue) {
				setFileError(issue);
				continue;
			}
			nextFiles = {
				...nextFiles,
				[classified]: [...nextFiles[classified], file],
			};
			changed = true;
			setFileError(null);
		}
		if (changed) setUploadFiles(nextFiles);
	};
	const chooseZip = (entry: PendingZip, uploadKind: 'GAME' | 'WEBGL' | 'ATTACHMENT') => {
		const issue = validateFile(entry.file, uploadKind, uploadFiles, true);
		if (issue) {
			setFileError(issue);
			return;
		}
		setUploadFiles((previous) => ({
			...previous,
			[uploadKind]: [...previous[uploadKind], entry.file],
		}));
		setPendingZips((previous) => previous.filter((item) => item.id !== entry.id));
		setFileError(null);
	};
	const removeSelectedFile = (uploadKind: ProjectUploadKind, index: number) =>
		setUploadFiles((previous) => ({
			...previous,
			[uploadKind]: previous[uploadKind].filter((_, fileIndex) => fileIndex !== index),
		}));
	const selectedFiles = (Object.entries(uploadFiles) as Array<[ProjectUploadKind, File[]]>).flatMap(
		([uploadKind, files]) => files.map((file, index) => ({ file, index, uploadKind })),
	);
	const hasUnpreparedSelection = !preparedManifest && (selectedFiles.length > 0 || pendingZips.length > 0);
	const uploadProgress = (uploadKind: ProjectUploadKind) => {
		if (!preparedManifest || !active?.stagingProjectId || !editable) return null;
		const planned = preparedManifest.filter(
			(item) =>
				item.kind === uploadKind &&
				(uploadFiles[uploadKind].length > 0 || uploadItemsByToken.get(item.clientToken)?.state !== 'READY'),
		);
		if (!planned.length) return null;
		const initialFiles = uploadFiles[uploadKind];
		const bindings = planned.map((item) => ({
			id: uploadItemsByToken.get(item.clientToken)?.id ?? '',
			clientToken: item.clientToken,
		}));
		const bound = initialFiles.length > 0;
		if (uploadKind === 'POSTER' || uploadKind === 'IMAGE')
			return (
				<DirectImageUploadWidget
					key={`${uploadKind}-${planned.map((item) => item.clientToken).join(':')}`}
					owner={{ type: 'PROJECT', id: active.stagingProjectId }}
					kind={uploadKind}
					initialFiles={initialFiles}
					autoStart={bound}
					compact={bound}
					submissionItems={bindings}
				/>
			);
		if (uploadKind === 'GAME' || uploadKind === 'WEBGL')
			return (
				<GameUploadWidget
					key={`${uploadKind}-${planned[0]!.clientToken}`}
					projectId={active.stagingProjectId}
					uploadKind={uploadKind}
					initialFile={initialFiles[0]}
					autoStart={bound}
					compact={bound}
					submissionItem={bindings[0]}
				/>
			);
		return (
			<DirectVideoUploadWidget
				key={`${uploadKind}-${planned.map((item) => item.clientToken).join(':')}`}
				projectId={active.stagingProjectId}
				kind={uploadKind}
				label={uploadKindLabels[uploadKind]}
				initialFiles={initialFiles}
				autoStart={bound}
				compact={bound}
				maxFiles={planned.length}
				maxFileBytes={uploadKind === 'VIDEO' ? undefined : materialLimits?.maxBytes}
				submissionItems={bindings}
			/>
		);
	};
	const existingFileControls = (
		<details className="project-change-existing-files">
			<summary>현재 파일 관리 · {project.assets.length}개{removedAssetIds.size > 0 && ` · 삭제 예정 ${removedAssetIds.size}개`}</summary>
			<p className="field-hint">
				체크한 파일은 승인될 때 제거됩니다. 새 파일은 이 요청의 임시 공간에만 업로드됩니다.
			</p>
			<div className="form-field">
				<label htmlFor="change-poster">대표 포스터</label>
				<SelectControl
					id="change-poster"
					disabled={!editable}
					value={effectivePosterId ?? ''}
					onChange={(event) =>
						setChanges({
							...changes,
							posterAssetId: event.target.value ? Number(event.target.value) : null,
						})
					}
				>
					<option value="">포스터 없음</option>
					{[...project.assets, ...(active?.stagedAssets ?? [])]
						.filter(
							(asset) =>
								(asset.kind === 'IMAGE' || asset.kind === 'POSTER') && !removedAssetIds.has(asset.id),
						)
						.map((asset) => (
							<option key={asset.id} value={asset.id}>
								{asset.originalName}
							</option>
						))}
				</SelectControl>
			</div>
			{project.assets.map((asset) => (
				<label key={asset.id} className="form-choice">
					<input
						type="checkbox"
						disabled={!editable}
						checked={removedAssetIds.has(asset.id)}
						onChange={() => toggleAssetRemoval(asset.id)}
					/>{' '}
					{asset.originalName} · {asset.kind === 'THUMBNAIL' ? '썸네일' : uploadKindLabels[asset.kind]}{removedAssetIds.has(asset.id) && ' · 승인 시 삭제'}
				</label>
			))}
			{videoAssetIds.length > 0 && (
				<div className="form-field">
					<label>동영상 순서</label>
					{videoAssetIds.map((assetId, index) => (
						<div key={assetId} className="member-add-row">
							<span>
								{index === 0 ? '메인' : `추가 ${index}`} ·{' '}
								{project.assets.find((asset) => asset.id === assetId)?.originalName ?? assetId}
							</span>
							<button
								type="button"
								className="btn btn--secondary btn--small"
								disabled={!editable || index === 0}
								onClick={() => moveVideo(assetId, -1)}
							>
								위로
							</button>
							<button
								type="button"
								className="btn btn--secondary btn--small"
								disabled={!editable || index === videoAssetIds.length - 1}
								onClick={() => moveVideo(assetId, 1)}
							>
								아래로
							</button>
						</div>
					))}
				</div>
			)}
			{project.webglUrl && (
				<label className="form-choice">
					<input
						type="checkbox"
						disabled={!editable}
						checked={formChanges.removeWebgl === true}
						onChange={(event) => setChanges({ ...changes, removeWebgl: event.target.checked })}
					/>{' '}
					현재 WebGL 빌드 삭제
				</label>
			)}
		</details>
	);
	const fileSelectionFooter = (
		<>
			{!materialLimits && (
				<p className="field-hint" role="status">
					자료 업로드 설정을 확인할 수 없어 문서와 첨부자료를 추가할 수 없습니다.{' '}
					<button
						type="button"
						className="btn btn--secondary btn--small"
						disabled={uploadConfigQuery.isFetching}
						onClick={() => void uploadConfigQuery.refetch()}
					>
						{uploadConfigQuery.isFetching ? '설정 조회 중…' : '설정 재시도'}
					</button>
				</p>
			)}
			{fileError && (
				<p className="field-error" role="alert">
					{fileError}
				</p>
			)}
			{pendingZips.length > 0 && (
				<ul className="project-upload-queue" aria-label="ZIP 용도 선택">
					{pendingZips.map((entry) => (
						<li key={entry.id}>
							<strong>{entry.file.name}</strong> · ZIP 용도를 선택하세요{' '}
							<div className="project-upload-queue__choices">
								{(['GAME', 'WEBGL', 'ATTACHMENT'] as const).map((uploadKind) => (
									<button
										key={uploadKind}
										type="button"
										className="btn btn--secondary btn--small"
										onClick={() => chooseZip(entry, uploadKind)}
									>
										{uploadKindLabels[uploadKind]}
									</button>
								))}
							</div>
							<button
								type="button"
								className="btn btn--secondary btn--small"
								onClick={() => setPendingZips((previous) => previous.filter((item) => item.id !== entry.id))}
							>
								제거
							</button>
						</li>
					))}
				</ul>
			)}
			{selectedFiles.length > 0 && (
				<ul className="project-upload-queue" aria-label="선택한 파일">
					{selectedFiles.map(({ file, index, uploadKind }) => (
						<li key={`${uploadKind}-${index}-${file.name}`}>
							<strong>{file.name}</strong> · {uploadKindLabels[uploadKind]} · {fileSizeLabel(file)}{' '}
							<button
								type="button"
								className="btn btn--secondary btn--small"
								onClick={() => removeSelectedFile(uploadKind, index)}
							>
								제거
							</button>
						</li>
					))}
				</ul>
			)}
		</>
	);
	const filesPanel = (
		<fieldset disabled={!editable || busy}>
			<legend className="submission-file-heading"><span>게임·미디어·자료</span><WebglBuildGuideLink /></legend>
			{preparedManifest ? (
				<>
					<p className="field-hint">
						임시 업로드 진행 상황입니다. 파일 검증이 끝나기 전에는 제출할 수 없습니다.
					</p>
					{!active?.stagingProjectId ? (
						<p className="field-hint">임시 업로드 공간을 준비하고 있습니다.</p>
					) : (
						<section className="project-change-upload-progress" aria-label="파일 업로드 진행">
							<h2>파일 업로드</h2>
							{(['IMAGE', 'VIDEO', 'DOCUMENT', 'ATTACHMENT', 'GAME', 'WEBGL'] as const).map(uploadProgress)}
						</section>
					)}
					{(active?.stagedAssets.length ?? 0) > 0 && (
						<p className="field-hint">
							임시 업로드됨: {active?.stagedAssets.map((asset) => asset.originalName).join(', ')}
						</p>
					)}
					{!uploadsReady && <p className="field-hint">모든 파일 검증이 완료될 때까지 제출할 수 없습니다.</p>}
				</>
			) : (
				<>
					<p className="field-hint">
						파일을 분류한 뒤 “업로드 준비”를 누르면 임시 공간을 만들고, 승인 전에는 공개 작품을 바꾸지
						않습니다.
					</p>
					<ProjectUploadDropZone
						zone="files"
						enabled={editable && !busy}
						onFiles={(files) => addFiles(files, 'files')}
						hint="이미지 · 동영상 · 문서 · 첨부자료를 자동 분류합니다. ZIP은 게임, WebGL 또는 첨부자료로 선택합니다."
						footer={fileSelectionFooter}
					/>
					<button
						type="button"
						className="btn btn--secondary"
						disabled={busy || selectedFiles.length === 0 || pendingZips.length > 0}
						onClick={() => prepareUploads.mutate(makeUploadManifest(uploadFiles).manifest)}
					>
						{prepareUploads.isPending ? '준비 중…' : '업로드 준비'}
					</button>
				</>
			)}
			<ProjectFileLimits limits={limits} materialLimits={materialLimits} />
			{existingFileControls}
		</fieldset>
	);

	return (
		<div className="admin-project-edit-page">
			<div className="admin-page-header project-edit-header">
				<div className="admin-page-header__text">
					<h1>작품 변경 요청</h1>
					<p>
						{project.title} · {project.year}년
					</p>
				</div>
				<Link className="btn btn--secondary project-edit-header__back" to="/me/projects" aria-disabled={busy} onClick={event => { if (busy) event.preventDefault(); }}>내 작품으로 돌아가기</Link>
			</div>
			{!active ? (
				<section className="project-form">
					<fieldset>
						<legend>요청 종류</legend>
						<label className="form-choice">
							<input name="change-kind" type="radio" checked={kind === 'EDIT'} onChange={() => setKind('EDIT')} /> 수정 요청
						</label>{' '}
						<label className="form-choice">
							<input name="change-kind" type="radio" checked={kind === 'DELETE'} onChange={() => setKind('DELETE')} /> 삭제 요청
						</label>
						<div className="form-field">
							<label htmlFor="change-reason">요청 사유 *</label>
							<textarea
								id="change-reason"
								rows={4}
								value={reason ?? ''}
								onChange={(e) => setReason(e.target.value)}
							/>
						</div>
						<button
							type="button"
							className="btn btn--primary"
							disabled={!reason?.trim() || busy}
							onClick={() => create.mutate()}
						>
							{create.isPending ? '생성 중…' : '요청 작성 시작'}
						</button>
					</fieldset>
				</section>
			) : (
				<>
					<p className="edit-meta">
						상태: <strong>{stateLabel[active.state] ?? active.state}</strong>
						{active.reviewReason ? ` · 운영자 의견: ${active.reviewReason}` : ''}
					</p>
					{active.kind === 'DELETE' ? (
						<section className="project-form">
							<fieldset disabled={!editable || busy}>
								<legend>삭제 요청</legend>
								<p>승인되면 작품과 연결된 파일이 삭제되며 복구할 수 없습니다.</p>
								<div className="form-field">
									<label htmlFor="delete-reason">요청 사유 *</label>
									<textarea
										id="delete-reason"
										rows={4}
										value={formReason}
										onChange={(e) => setReason(e.target.value)}
									/>
								</div>
							</fieldset>
							{editable && (
								<fieldset disabled={busy}>
									<legend>제출</legend>
									<button
										type="button"
										className="btn btn--secondary"
										disabled={busy}
										onClick={() => save.mutate()}
									>
										{save.isPending ? '저장 중…' : '초안 저장'}
									</button>{' '}
									<button
										type="button"
										className="btn btn--primary"
										disabled={busy || !formReason.trim()}
										onClick={() => submit.mutate()}
									>
										운영자에게 제출
									</button>{' '}
									<button
										type="button"
										className="btn btn--danger"
										disabled={busy}
										onClick={() => cancel.mutate()}
									>
										요청 취소
									</button>
								</fieldset>
							)}
						</section>
					) : (
						<ProjectEditorLayout
							actions={editable && <div className="project-edit-apply project-change-actions" aria-label="수정 요청 저장·제출">
								<div className="project-edit-apply__feedback" aria-live="polite">
									<p>초안은 저장 후에도 편집할 수 있으며, 공개 작품에는 운영자 승인 후 반영됩니다.</p>
									{busy ? <p>요청을 처리하고 있습니다…</p> : !formReason.trim() ? <p>요청 사유를 입력하세요.</p> : hasUnpreparedSelection ? <p>파일 목록에서 ZIP 용도 선택과 업로드 준비를 완료하세요.</p> : !uploadsReady ? <p>파일 업로드·검증을 완료하세요. 실패한 파일은 파일 목록에서 다시 시도하세요.</p> : null}
								</div>
								<button
									type="button"
									className="btn btn--secondary"
									disabled={busy}
									onClick={() => save.mutate()}
								>
									{save.isPending ? '저장 중…' : '초안 저장'}
								</button>{' '}
								<button
									type="button"
									className="btn btn--primary"
									disabled={busy || !formReason.trim() || !uploadsReady || hasUnpreparedSelection}
									onClick={() => submit.mutate()}
								>
									운영자에게 제출
								</button>{' '}
								<button
									type="button"
									className="btn btn--danger"
									disabled={busy}
									onClick={() => cancel.mutate()}
								>
									요청 취소
								</button>
							</div>}
							poster={
								<fieldset disabled={!editable || busy}>
									<legend>포스터</legend>
									<ProjectUploadDropZone
										zone="poster"
										enabled={editable && !busy && !preparedManifest}
										onFiles={(files) => addFiles(files, 'poster')}
										hint="새 포스터는 승인 전까지 공개 작품에 반영되지 않습니다."
										footer={
											preparedManifest ? (
												uploadProgress('POSTER')
											) : uploadFiles.POSTER[0] ? (
												<p className="file-info">
													선택됨: {uploadFiles.POSTER[0].name} · {fileSizeLabel(uploadFiles.POSTER[0])}{' '}
													<button
														type="button"
														className="btn btn--secondary btn--small"
														onClick={() => removeSelectedFile('POSTER', 0)}
													>
														제거
													</button>
												</p>
											) : undefined
										}
									>
										<ProjectPosterPreview
											image={project.poster}
											title={formChanges.title || project.title}
											localFile={uploadFiles.POSTER[0]}
										/>
									</ProjectUploadDropZone>
								</fieldset>
							}
							details={
								<>
									<fieldset className="project-basic-fields" disabled={!editable || busy}>
										<legend>기본 정보</legend>
										<div className="form-field">
											<label htmlFor="change-title">제목 *</label>
											<input
												id="change-title"
												value={formChanges.title ?? ''}
												onChange={(e) => setChanges({ ...changes, title: e.target.value })}
											/>
										</div>
										<div className="form-field">
											<label htmlFor="change-summary">한줄 소개</label>
											<input
												id="change-summary"
												value={formChanges.summary ?? ''}
												onChange={(e) => setChanges({ ...changes, summary: e.target.value })}
											/>
										</div>
										<div className="form-field">
											<label htmlFor="change-description">상세 설명</label>
											<textarea
												id="change-description"
												rows={3}
												value={formChanges.description ?? ''}
												onChange={(e) =>
													setChanges({
														...changes,
														description: e.target.value,
													})
												}
											/>
										</div>

									</fieldset>

									<fieldset disabled={!editable || busy}>
										<legend>참여 학생</legend>
										{formMembers.map((member, index) => (
											<div className="member-add-row" key={index}>
												<input
													className="form-control"
													aria-label={`참여 학생 ${index + 1} 이름`}
													value={member.name}
													onChange={(e) => {
														setMembersTouched(true);
														setMembers(
															formMembers.map((value, memberIndex) =>
																memberIndex === index ? { ...value, name: e.target.value } : value,
															),
														);
													}}
												/>
												<input
													className="form-control"
													aria-label={`참여 학생 ${index + 1} 학번`}
													value={member.studentId}
													onChange={(e) => {
														setMembersTouched(true);
														setMembers(
															formMembers.map((value, memberIndex) =>
																memberIndex === index ? { ...value, studentId: e.target.value } : value,
															),
														);
													}}
												/>
												<button
													type="button"
													className="btn btn--danger btn--small"
													onClick={() => {
														setMembersTouched(true);
														setMembers(formMembers.filter((_, memberIndex) => memberIndex !== index));
													}}
												>
													삭제
												</button>
											</div>
										))}
										<button
											type="button"
											className="btn btn--secondary btn--small"
											onClick={() => {
												setMembersTouched(true);
												setMembers([...formMembers, { name: '', studentId: '' }]);
											}}
										>
											참여 학생 추가
										</button>
									</fieldset>
									<div className="project-environment-links">
										<ProjectRequirementsFieldset platforms={formChanges.platforms ?? []} hardwareRequirements={formChanges.hardwareRequirements ?? ''} onPlatformsChange={(platforms) => setChanges({ ...changes, platforms })} onHardwareRequirementsChange={(hardwareRequirements) => setChanges({ ...changes, hardwareRequirements })} disabled={!editable || busy} />
										<ExternalLinksFieldset value={formLinks} onChange={(externalLinks) => setChanges({ ...changes, externalLinks })} disabled={!editable || busy} showErrors />
									</div>
									{editable && (
										<fieldset>
											<legend>제출</legend>
											<div className="form-field">
												<label htmlFor="draft-reason">요청 사유 *</label>
												<textarea
													id="draft-reason"
													rows={3}
													value={formReason}
													onChange={(e) => setReason(e.target.value)}
												/>
											</div>

										</fieldset>
									)}
								</>
							}
							files={filesPanel}
						/>
					)}
				</>
			)}
			{mutationError && (
				<p className="error-box" role="alert">
					{getApiErrorMessage(mutationError)}
				</p>
			)}
		</div>
	);
}
