import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminProjectDetail } from '@pcu/contracts';
import { publicApi } from '../../../lib/api';
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
	const refreshing = useRef(false);
	const qc = useQueryClient();
	const config = useQuery({
		queryKey: ['public-upload-config'],
		queryFn: publicApi.getUploadConfig,
		enabled,
	});
	const materialLimits = materialUploadLimitsFromConfig(config.data);
	const issues = uploadQueueIssues(entries, project, limits, materialLimits);
	const active = entries.find((entry) => entry.status === 'active');
	const next = entries.find(
		(entry) => entry.status === 'pending' && entry.kind !== 'ZIP' && !issues.has(entry.id),
	);
	useEffect(() => {
		if (enabled && !active && next) dispatch({ type: 'status', id: next.id, status: 'active' });
	}, [enabled, active, next]);
	const add = (files: File[], zone: UploadZone) => {
		if (!enabled || files.length === 0) return;
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
	const complete = useCallback(
		async (id: number) => {
			if (refreshing.current) return;
			refreshing.current = true;
			setRefreshError(false);
			try {
				// Do not release reserved capacity until the canonical detail has refreshed.
				await qc.invalidateQueries({ queryKey: queryKeys.adminProject(projectId) }, { throwOnError: true });
				dispatch({ type: 'status', id, status: 'done' });
			} catch {
				setRefreshError(true);
			} finally {
				refreshing.current = false;
			}
		},
		[projectId, qc],
	);
	const cancel = useCallback((id: number) => dispatch({ type: 'status', id, status: 'cancelled' }), []);
	const owner = useMemo(() => ({ type: 'PROJECT' as const, id: projectId }), [projectId]);
	return {
		entries,
		active,
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
		choose: (id: number, kind: 'GAME' | 'WEBGL' | 'ATTACHMENT') => dispatch({ type: 'choose', id, kind }),
	};
}
export type ProjectUploadQueue = ReturnType<typeof useProjectUploadQueue>;
