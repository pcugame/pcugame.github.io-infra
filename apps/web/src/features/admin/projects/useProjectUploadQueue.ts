import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
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
} from '../../../lib/upload/project-files';

type Action =
	| { type: 'add'; entries: UploadEntry[] }
	| { type: 'status'; id: number; status: UploadEntry['status'] }
	| { type: 'choose'; id: number; kind: 'GAME' | 'WEBGL' | 'ATTACHMENT' };
function reducer(entries: UploadEntry[], action: Action): UploadEntry[] {
	if (action.type === 'add') return [...entries, ...action.entries];
	return entries.map((entry) =>
		entry.id !== action.id
			? entry
			: action.type === 'choose'
				? { ...entry, kind: action.kind }
				: { ...entry, status: action.status },
	);
}
export function useProjectUploadQueue(
	project: AdminProjectDetail,
	projectId: number,
	limits: ClientUploadLimits,
	enabled: boolean,
) {
	const [entries, dispatch] = useReducer(reducer, []);
	const [posterError, setPosterError] = useState<string | null>(null);
	const [refreshError, setRefreshError] = useState(false);
	const nextId = useRef(0);
	const [locked, setLocked] = useState(false);
	const [isApplying, setIsApplying] = useState(false);
	const applying = useRef(false);
	const completedUploads = useRef(new Set<number>());
	const interruptedApply = useRef<Error | null>(null);
	const [retryAttempt, setRetryAttempt] = useState(0);
	const [submissionItem, setSubmissionItem] = useState<{ id: string; clientToken: string }>();
	const [removals, setRemovals] = useState<number[]>([]);
	const [removeWebgl, setRemoveWebgl] = useState(false);
	const deleted = useRef(new Set<number>());
	const webglDeleted = useRef<string | null>(null);
	const webglIdentity = project.webglDeployment?.id ?? project.webglUrl ?? null;
	const refreshNeeded = useRef(false);
	const waiter = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
	const qc = useQueryClient();
	const { user } = useMe();
	const submissionApi = getProjectSubmitApi(user?.role === 'USER' ? 'user' : 'admin');
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
	const add = (files: File[], zone: UploadZone) => {
		if (!enabled || locked || applying.current || files.length === 0) return;
		if (zone === 'poster') {
			if (files.length !== 1 || classifyProjectFile(files[0]!, zone) !== 'POSTER') {
				setPosterError('포스터는 JPG·PNG·WebP·PDF 파일 한 개만 선택해 주세요.');
				return;
			}
			setPosterError(null);
		}
		dispatch({
			type: 'add',
			entries: files.map((file) => ({
				id: ++nextId.current,
				file,
				zone,
				kind: classifyProjectFile(file, zone)!,
				status: 'pending',
			})),
		});
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
	const complete = useCallback((id: number) => {
		// Checkpoint the completed transfer before refreshing; a failed read must never repeat it.
		completedUploads.current.add(id);
		dispatch({ type: 'status', id, status: 'done' });
		refreshNeeded.current = true;
		waiter.current?.resolve();
		waiter.current = null;
	}, []);
	const fail = useCallback((message: string) => {
		const error = new Error(message);
		if (applying.current) interruptedApply.current = error;
		waiter.current?.reject(error);
		waiter.current = null;
	}, []);
	const cancel = useCallback((id: number) => {
		dispatch({ type: 'status', id, status: 'cancelled' });
		fail('파일 업로드를 취소했습니다. 남은 변경사항을 확인한 뒤 다시 적용해 주세요.');
	}, [fail]);
	const applyChanges = async () => {
		if (applying.current) throw new Error('파일 변경사항을 적용하고 있습니다.');
		if (!enabled && (pending.length || removals.length || removeWebgl)) throw new Error('파일을 수정할 권한이 없습니다.');
		if (validationError) throw new Error(validationError);
		interruptedApply.current = null;
		applying.current = true;
		setIsApplying(true);
		const checkInterrupted = () => {
			if (interruptedApply.current) throw interruptedApply.current;
		};
		try {
			if (refreshNeeded.current) await refresh();
			for (const id of removals) {
				checkInterrupted();
				if (deleted.current.has(id)) continue;
				await adminAssetApi.remove(id);
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
			for (const entry of pending) {
				checkInterrupted();
				// A widget retry can finish while deletion or canonical refresh is awaited.
				if (completedUploads.current.has(entry.id)) continue;
				if (project.status === 'DRAFT') {
					const submission = await submissionApi.getSubmission(projectId);
					if (submission.state !== 'PENDING') throw new Error('제출 처리 중이거나 종료된 작품입니다. 페이지를 새로고침해 주세요.');
					const item = [...submission.items]
						.sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }))
						.find((item) => item.kind === entry.kind && item.state !== 'READY');
					if (!item) throw new Error('이 종류의 제출 파일은 이미 업로드되었거나 제출 목록에 없습니다. 제출 완료 후 파일을 추가·교체해 주세요.');
					setSubmissionItem({ id: item.id, clientToken: item.clientToken });
				} else {
					setSubmissionItem(undefined);
				}
				await new Promise<void>((resolve, reject) => {
					waiter.current = { resolve, reject };
					if (entry.status === 'active') setRetryAttempt((attempt) => attempt + 1);
					else dispatch({ type: 'status', id: entry.id, status: 'active' });
				});
				await refresh();
			}
			checkInterrupted();
		} finally {
			applying.current = false;
			setIsApplying(false);
		}
	};
	const owner = useMemo(() => ({ type: 'PROJECT' as const, id: projectId }), [projectId]);
	return {
		entries,
		project,
		locked: locked || isApplying,
		setLocked,
		isApplying,
		hasChanges: pending.length > 0 || removals.length > 0 || removeWebgl || refreshNeeded.current || refreshError,
		validationError,
		applyChanges,
		fail,
		retryAttempt,
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
		submissionItem,
		issues,
		add,
		complete,
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
