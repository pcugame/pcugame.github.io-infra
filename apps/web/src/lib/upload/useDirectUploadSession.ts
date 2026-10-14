import { useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { DirectAssetUploadSession } from '../api/game-upload';
import { getDirectUploadTask, type DirectUploadTask, type Locator, type Recovery, type TaskCallbacks, type UploadRun } from './directUploadTask';
type TransferArgs = Parameters<DirectUploadTask['transfer']>[1];
export type { UploadRun } from './directUploadTask';

/** React owns a view lease; the job retains unresolved requests across views. */
export function useDirectUploadSession<Saved extends Locator>({
	storageKey, recovery, operationKey, ...callbacks
}: { storageKey: string; operationKey?: string; recovery?: Omit<Recovery, 'mode'> } & TaskCallbacks<Saved>) {
	const identity = operationKey ?? (recovery?.items.length ? `submission:${recovery.items.map(item => item.id).join(':')}` : undefined);
	const client = useContext(QueryClientContext);
	const me = client?.getQueryData<{ user?: { id: number; role: string } }>(['me']);
	const scope = String(me?.user?.id ?? 'current-user');
	const task = useMemo(() => getDirectUploadTask(scope, storageKey), [scope, storageKey]);
	const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot);
	const mounted = useRef(false);
	const currentView = useRef({ task, identity });
	const id = useRef({});
	const latest = useRef(callbacks);
	const recoveryRef = useRef(recovery);
	useEffect(() => { latest.current = callbacks; recoveryRef.current = recovery; currentView.current = { task, identity }; });
	useEffect(() => {
		mounted.current = true;
		task.identify(identity);
		const detach = task.attach(id.current, {
			onCancelled: () => {
				if (task.matchesOperation(identity)) latest.current.onCancelled?.();
				else latest.current.onCancelError(new Error('이전 업로드가 취소되었습니다. 선택한 파일을 다시 시도해 주세요.'));
			},
			onCancelReady: (saved, state, status) => latest.current.onCancelReady(saved as Saved, state, status),
			onCancelError: (cause, terminal, status) => latest.current.onCancelError(cause, terminal, status),
			onCancelSettled: () => latest.current.onCancelSettled(),
		});
		return () => { mounted.current = false; detach(); };
	}, [task, identity]);
	const isMounted = useCallback(() => mounted.current && currentView.current.task === task && currentView.current.identity === identity, [task, identity]);
	const isCurrentRun = useCallback((token: number) => isMounted() && task.isCurrentRun(token), [task, isMounted]);
	const restoreRequired = useCallback(() => Boolean(task.getSaved() || task.hasUnresolved() || recoveryRef.current?.items.length), [task]);
	const restore = useCallback(async () => {
		const spec = recoveryRef.current;
		const saved = await task.restore(spec ? { ...spec, mode: me?.user?.role === 'USER' ? 'user' : 'admin' } : undefined);
		if (saved === undefined) return undefined;
		return saved && task.getSaved() === saved ? saved as Saved : null;
	}, [task, me?.user?.role]);
	const acceptReady = useCallback((run: UploadRun, sessionId: string, generation: number) => {
		if (!task.acceptReady(run, sessionId, generation)) return false;
		if (task.matchesOperation(identity)) return true;
		latest.current.onCancelError(new Error('이전 파일의 업로드가 완료되었습니다. 선택한 파일을 재시도해 주세요.'));
		return false;
	}, [task, identity]);
	const transfer = useCallback((run: UploadRun, args: TransferArgs, toSaved: (session: DirectAssetUploadSession) => Saved) => task.transfer(run, args, toSaved, identity), [task, identity]);
	const cancel = useCallback(async () => {
		const spec = recoveryRef.current;
		await task.cancel(spec ? { ...spec, mode: me?.user?.role === 'USER' ? 'user' : 'admin' } : undefined);
		if (task.hasUnresolved() && !task.isPendingCreate()) await restore().catch(() => undefined);
	}, [task, restore, me?.user?.role]);
	return {
		saved: snapshot.saved as Saved | null, taskMessage: snapshot.message, handoff: snapshot.handoff,
		canContinue: snapshot.control === 'open', cancelPending: snapshot.control === 'cancelling' || snapshot.control === 'completion',
		restore, restoreRequired, matchesFile: task.matchesFile, isPendingCreate: task.isPendingCreate, getSaved: task.getSaved as () => Saved | null,
		remember: task.remember as (saved: Saved, updateUi?: boolean) => void,
		forget: task.forget, beginRun: task.beginRun, finishRun: task.finishRun,
		pause: task.pause, cancel,
		transfer,
		acceptReady, isMounted, isCurrentRun,
	};
}
