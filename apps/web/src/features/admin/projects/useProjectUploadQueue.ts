import { FileUploadQueue } from '../../../lib/upload/fileUploadQueue';
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminProjectDetail } from '@pcu/contracts';
import { adminAssetApi, adminProjectApi, publicApi } from '../../../lib/api';
import { getProjectSubmitApi } from '../../../lib/api/project-submit';
import { useMe } from '../../auth';
import { queryKeys } from '../../../lib/query';
import { materialUploadLimitsFromConfig, type ClientUploadLimits } from '../../../lib/upload-limits';
import {
	classifyProjectFile,
	uploadQueueIssues,
	type UploadEntry,
	type UploadZone,
	type ProjectUploadKind,
} from '../../../lib/upload/project-files';

type Action =
	| { type: 'add'; entries: UploadEntry[] }
	| { type: 'status'; id: number; status: UploadEntry['status']; file?: UploadEntry['file']; sizeKnown?: boolean; binding?: UploadEntry['binding'] }
	| { type: 'choose'; id: number; kind: 'GAME' | 'WEBGL' | 'ATTACHMENT' };
function reducer(entries: UploadEntry[], action: Action): UploadEntry[] {
	if (action.type === 'add') return [...entries, ...action.entries];
	return entries.map((entry) =>
		entry.id !== action.id
			? entry
			: action.type === 'choose'
				? { ...entry, kind: action.kind }
				: { ...entry, status: action.status, file: action.file ?? entry.file, sizeKnown: action.sizeKnown ?? entry.sizeKnown, binding: action.binding ?? entry.binding },
	);
}
export function useProjectUploadQueue(
	project: AdminProjectDetail,
	projectId: number,
	limits: ClientUploadLimits,
	enabled: boolean,
) {
	const queueId = useId();
	const qc = useQueryClient();
	const { user } = useMe();
	const selectionKey = `pcu.edit-upload-files:${user?.id ?? 'current-user'}:${projectId}`;
	const [entries, dispatch] = useReducer(reducer, selectionKey, key => {
		try {
			const raw = window.sessionStorage.getItem(key);
			const saved = raw ? JSON.parse(raw) as UploadEntry[] : Object.keys(window.sessionStorage)
				.filter(storageKey => storageKey.startsWith(`pcu.file-upload:${user?.id ?? 'current-user'}:PROJECT:${projectId}:`) && storageKey.endsWith(':file'))
				.map((storageKey, index) => {
					const record = JSON.parse(window.sessionStorage.getItem(storageKey)!);
					return { id: index + 1, uploadId: record.id, kind: record.kind, zone: record.kind === 'POSTER' ? 'poster' : 'files', status: 'pending', binding: record.binding, sizeKnown: record.size !== undefined,
						file: { name: record.name, size: record.size ?? 0, type: '' } } as UploadEntry;
				});
			if (!Array.isArray(saved) || saved.some(entry => !entry.uploadId || !Number.isSafeInteger(entry.id) || !entry.file?.name || !Number.isSafeInteger(entry.file.size))) return [];
			return saved.map(entry => {
				const outcome = window.sessionStorage.getItem(`pcu.file-upload:${user?.id ?? 'current-user'}:PROJECT:${projectId}:${entry.kind}:${entry.uploadId}:outcome`);
				return { ...entry, status: outcome === 'ready' ? 'done' as const : outcome === 'cancelled' ? 'cancelled' as const : entry.status === 'active' ? 'pending' as const : entry.status };
			});
		} catch { return []; }
	});
	useEffect(() => {
		window.sessionStorage.setItem(selectionKey, JSON.stringify(entries.map(entry => ({ ...entry, file: { name: entry.file.name, size: entry.file.size, type: entry.file.type } }))));
	}, [selectionKey, entries]);
	const [posterError, setPosterError] = useState<string | null>(null);
	const [refreshError, setRefreshError] = useState(false);
	const nextId = useRef(Math.max(0, ...entries.map(entry => entry.id)));
	const [locked, setLocked] = useState(false);
	const [isApplying, setIsApplying] = useState(false);
	const applying = useRef(false);
	const completedUploads = useRef(new Set(entries.filter(entry => entry.status === 'done').map(entry => entry.id)));
	const interruptedApply = useRef<Error | null>(null);

	const [removals, setRemovals] = useState<number[]>([]);
	const [removeWebgl, setRemoveWebgl] = useState(false);
	const deleted = useRef(new Set<number>());
	const webglDeleted = useRef<string | null>(null);
	const webglIdentity = project.webglDeployment?.id ?? project.webglUrl ?? null;
	const refreshNeeded = useRef(false);

	const submissionApi = getProjectSubmitApi(user?.role === 'USER' ? 'user' : 'admin');
	const uploads = useMemo(() => new FileUploadQueue(String(user?.id ?? 'current-user'), user?.role === 'USER' ? 'user' : 'admin', String(projectId)), [projectId, user?.id, user?.role]);
	useEffect(() => uploads.attach(), [uploads]);
	useEffect(() => {
		uploads.onChange = row => {
			const entry = entries.find(entry => entry.uploadId === row.id);
			if (!entry) return;
			const status = row.phase === 'ready' ? 'done' : row.phase === 'failed' || row.phase === 'cancel-unconfirmed' ? 'failed' : row.phase === 'cancelled' ? 'cancelled' : row.phase === 'waiting' ? 'pending' : 'active';
			if (status === 'done') { completedUploads.current.add(entry.id); refreshNeeded.current = true; }
			dispatch({ type: 'status', id: entry.id, status, binding: row.binding, sizeKnown: row.size !== undefined, file: row.file ?? (row.size !== undefined ? { name: row.name, size: row.size, type: entry.file.type } : undefined) });
		};
		return () => { uploads.onChange = undefined; };
	}, [uploads, entries]);
	useEffect(() => {
		for (const entry of entries) if (entry.status === 'removed') uploads.discardUnstarted(entry.uploadId);
		uploads.sync(entries.filter(entry => entry.kind !== 'ZIP' && entry.status !== 'removed').map(entry => ({ id: entry.uploadId, owner: { type: 'PROJECT', id: projectId }, kind: entry.kind as ProjectUploadKind, file: entry.file instanceof File ? entry.file : undefined, name: entry.file.name, size: entry.sizeKnown === false ? undefined : entry.file.size, binding: entry.binding })));
		uploads.order(entries.map(entry => entry.uploadId));
	}, [uploads, entries, projectId]);
	const config = useQuery({
		queryKey: ['public-upload-config'],
		queryFn: publicApi.getUploadConfig,
		enabled,
	});
	const materialLimits = materialUploadLimitsFromConfig(config.data);
	const effectiveProject = {
		...project,
		assets: project.assets.filter((asset) => !removals.includes(asset.id) && !deleted.current.has(asset.id)),
		videos: project.videos.filter((asset) => !removals.includes(asset.assetId) && !deleted.current.has(asset.assetId)),
		attachments: project.attachments?.filter((asset) => !removals.includes(asset.assetId) && !deleted.current.has(asset.assetId)),
	};
	const issues = uploadQueueIssues(entries, effectiveProject, limits, materialLimits);
	const active = entries.find((entry) => entry.status === 'active');
	const pending = entries.filter((entry) => entry.status === 'pending' || entry.status === 'active');
	const validationError = pending.some((entry) => entry.kind === 'ZIP')
		? 'ZIP 파일의 용도를 선택해 주세요.'
		: issues.values().next().value ?? null;
	const add = (files: File[], zone: UploadZone, kinds?: ProjectUploadKind[]): string | null => {
		if (!enabled || locked || applying.current || files.length === 0) return null;
		if (zone === 'poster') {
			if (files.length !== 1 || classifyProjectFile(files[0]!, zone) !== 'POSTER') {
				setPosterError('포스터는 JPG·PNG·WebP·PDF 파일 한 개만 선택해 주세요.');
				return '포스터는 JPG·PNG·WebP·PDF 파일 한 개만 선택해 주세요.';
			}
			setPosterError(null);
		}
		const chosen = files.map((file, index) => ({ id: ++nextId.current, uploadId: crypto.randomUUID(), file, zone, kind: kinds?.[index] ?? classifyProjectFile(file, zone)!, status: 'pending' as const }));
		if (kinds) {
			if (chosen.some(entry => entry.file.size === 0)) return '빈 파일은 선택할 수 없습니다.';
			const replacements = chosen.filter(entry => entry.kind === 'GAME' || entry.kind === 'WEBGL' || entry.kind === 'POSTER').map(entry => entry.kind);
			if (entries.some(entry => entry.status === 'pending' && replacements.includes(entry.kind) && !uploads.canDiscardUnstarted(entry.uploadId))) return '이전 업로드를 먼저 확인하거나 취소해 주세요.';
			const kept = entries.filter(entry => entry.status !== 'pending' || !replacements.includes(entry.kind));
			const errors = uploadQueueIssues([...kept, ...chosen], effectiveProject, limits, materialLimits);
			const error = chosen.map(entry => errors.get(entry.id)).find(Boolean);
			if (error) return error;
			for (const entry of entries) if (entry.status === 'pending' && replacements.includes(entry.kind)) dispatch({ type: 'status', id: entry.id, status: 'removed' });
		}
		dispatch({
			type: 'add',
			entries: chosen,
		});
		return null;
	};
	const refresh = useCallback(async () => {
		try {
			await qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) }, { throwOnError: true });
			refreshNeeded.current = false;
			setRefreshError(false);
		} catch (error) {
			setRefreshError(true);
			throw error;
		}
	}, [projectId, qc]);
	const fail = useCallback((message: string) => { interruptedApply.current = new Error(message); }, []);
	const cancel = useCallback((id: number) => {
		const entry = entries.find(entry => entry.id === id);
		if (!entry || completedUploads.current.has(id)) return;
		if (!applying.current && entry.status === 'pending' && uploads.discardUnstarted(entry.uploadId)) dispatch({ type: 'status', id, status: 'removed' });
		else void uploads.cancel(entry.uploadId);
	}, [entries, uploads]);
	const applyChanges = async () => {
		if (applying.current) throw new Error('파일 변경사항을 적용하고 있습니다.');
		if (!enabled && (entries.some(entry => entry.status !== 'done' && entry.status !== 'removed') || removals.length || removeWebgl)) throw new Error('파일을 수정할 권한이 없습니다.');
		if (validationError) throw new Error(validationError);
		interruptedApply.current = null;
		applying.current = true;
		setIsApplying(true);
		const checkInterrupted = () => {
			if (interruptedApply.current) throw interruptedApply.current;
		};
		try {
			if (refreshNeeded.current) await refresh();
			const chosen = entries.filter(entry => entry.status === 'pending' || entry.status === 'failed' || entry.status === 'active');
			let submission: Awaited<ReturnType<typeof submissionApi.getSubmission>> | undefined;
			if (project.status === 'DRAFT' && chosen.length) {
				submission = await submissionApi.getSubmission(projectId);
				if (submission.state !== 'PENDING') throw new Error('제출 처리 중이거나 종료된 작품입니다. 페이지를 새로고침해 주세요.');
			}
			const used = new Set<string>();
			const specs = chosen.filter(entry => entry.kind !== 'ZIP').map(entry => {
				const binding = entry.binding ? submission?.items.find(item => item.id === entry.binding?.id && item.clientToken === entry.binding.clientToken) ?? entry.binding : submission?.items.find(item => item.kind === entry.kind && item.state !== 'READY' && !used.has(item.id));
				if (binding) { used.add(binding.id); dispatch({ type: 'status', id: entry.id, status: entry.status, binding }); }
				return { id: entry.uploadId, owner: { type: 'PROJECT' as const, id: projectId }, kind: entry.kind as ProjectUploadKind, file: entry.file instanceof File ? entry.file : undefined, name: entry.file.name, size: entry.sizeKnown === false ? undefined : entry.file.size, binding,
					legacyKey: entry.kind === 'GAME' || entry.kind === 'WEBGL' ? `pcu.direct-asset-upload:${projectId}:${entry.kind}` : entry.kind === 'IMAGE' || entry.kind === 'POSTER' ? `pcu.direct-${entry.kind.toLowerCase()}-upload:PROJECT:${projectId}` : `pcu.direct-${entry.kind.toLowerCase()}-upload:${projectId}` };
			});
			uploads.sync(specs);
			await uploads.start(chosen.map(entry => entry.uploadId));
			checkInterrupted();
			if (uploads.getSnapshot().some(row => row.phase !== 'ready')) throw new Error('미완료 파일이 있습니다. 해당 파일을 재시도해 주세요.');
			if (refreshNeeded.current) await refresh();
			for (const id of removals) {
				checkInterrupted();
				if (deleted.current.has(id)) continue;
				const latest = await adminProjectApi.getDetail(projectId);
    if (latest.assets.some(asset => asset.id === id)) await adminAssetApi.remove(id);
				deleted.current.add(id);
				setRemovals((ids) => ids.filter((value) => value !== id));
				refreshNeeded.current = true;
			}
			checkInterrupted();
			if (removeWebgl && webglDeleted.current !== webglIdentity) {
				await adminProjectApi.deleteWebgl(projectId);
				webglDeleted.current = webglIdentity;
				setRemoveWebgl(false);
				refreshNeeded.current = true;
			}
			if (refreshNeeded.current) await refresh();

			checkInterrupted();
			window.sessionStorage.removeItem(selectionKey);
			uploads.clearRecoveryMetadata();
		} finally {
			applying.current = false;
			setIsApplying(false);
		}
	};
	const owner = useMemo(() => ({ type: 'PROJECT' as const, id: projectId }), [projectId]);
	return {
		limits,
		enabled,
		queueId,
		entries,
		project,
		locked: locked || isApplying,
		setLocked,
		isApplying,
		hasChanges: entries.some(entry => entry.status !== 'done' && entry.status !== 'removed') || removals.length > 0 || removeWebgl || refreshNeeded.current || refreshError,
		validationError,
		applyChanges,
		fail,
		uploads,
		cancelAll: () => { interruptedApply.current = new Error('파일 업로드를 취소했습니다. 남은 변경사항을 확인한 뒤 다시 적용해 주세요.'); void uploads.cancelAll(); },
		removals,
		removeWebgl,
		storedAssets: project.assets.filter((asset) => !deleted.current.has(asset.id)),
		hasWebgl: webglIdentity !== null && webglIdentity !== webglDeleted.current,
		toggleRemoval: (id: number) => {
			if (!enabled || locked || applying.current) return;
			setRemovals((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]);
		},
		toggleWebglRemoval: () => {
			if (enabled && !locked && !applying.current) setRemoveWebgl((value) => !value);
		},
		active,
		issues,
		add,
		cancel,
		owner,
		posterError,
		refreshError,
		materialLimits,
		configUnavailable: !materialLimits,
		configLoading: config.isFetching,
		retryConfig: () => void config.refetch(),
		choose: (id: number, kind: 'GAME' | 'WEBGL' | 'ATTACHMENT') => {
			if (enabled && !locked && !applying.current) dispatch({ type: 'choose', id, kind });
		},
	};
}
export type ProjectUploadQueue = ReturnType<typeof useProjectUploadQueue>;
