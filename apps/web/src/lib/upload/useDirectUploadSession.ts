import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import type { DirectAssetUploadSession } from '../api/game-upload';
import { fileVerificationMessage, sessionOf, getDirectUploadTask, type DirectUploadTask, type Locator, type Recovery, type TaskCallbacks, type UploadRun } from './directUploadTask';
type TransferArgs = Parameters<DirectUploadTask['transfer']>[1];
export type { UploadRun } from './directUploadTask';

/**
 * React owns the view and selection lease; the job retains server responsibility.
 * Call selectFiles synchronously for every selection change, alongside local state.
 */
export function useDirectUploadSession<Saved extends Locator>({
	storageKey, recovery, operationKey, initialSelection, ...callbacks
}: { storageKey: string; operationKey?: string; initialSelection: readonly File[]; recovery?: Omit<Recovery, 'mode'> } & TaskCallbacks<Saved>) {
	const identity = operationKey ?? (recovery?.items.length ? `submission:${recovery.items.map(item => item.id).join(':')}` : undefined);
	const client = useContext(QueryClientContext);
	const me = client?.getQueryData<{ user?: { id: number; role: string } }>(['me']);
	const scope = String(me?.user?.id ?? 'current-user');
	const task = useMemo(() => getDirectUploadTask(scope, storageKey), [scope, storageKey]);
	const snapshot = useSyncExternalStore(task.subscribe, task.getSnapshot);
	const mounted = useRef(false);
	const selection = useRef({ files: initialSelection, generation: 0 });
	const runs = useRef(new Map<number, { files: readonly File[]; generation: number }>());
	const currentView = useRef({ task, identity });
	const id = useRef({});
	const latest = useRef(callbacks);
	const recoveryRef = useRef(recovery);
	useLayoutEffect(() => { latest.current = callbacks; recoveryRef.current = recovery; currentView.current = { task, identity }; });
	useLayoutEffect(() => {
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
	// Selecting a file revokes local execution ownership, not the saved server job.
	// Update synchronously in input handlers, before React commits the new state.
	const selectFiles = useCallback((files: readonly File[]) => {
		selection.current = { files, generation: selection.current.generation + 1 };
		task.pause();
	}, [task]);
	const getSelectedFiles = useCallback(() => selection.current.files, []);
	const beginRun = useCallback(() => {
		if (!isMounted()) return null;
		const run = task.beginRun();
		if (run) { runs.current.clear(); runs.current.set(run.token, selection.current); }
		return run;
	}, [task, isMounted]);
	const isCurrentRun = useCallback((token: number) => isMounted() && task.isCurrentRun(token)
		&& runs.current.get(token)?.generation === selection.current.generation, [task, isMounted]);
	const restoreRequired = useCallback(() => Boolean(task.getSaved() || task.hasUnresolved() || recoveryRef.current?.items.length), [task]);
	const restore = useCallback(async () => {
		const spec = recoveryRef.current;
		const saved = await task.restore(spec ? { ...spec, mode: me?.user?.role === 'USER' ? 'user' : 'admin' } : undefined);
		if (saved === undefined) return undefined;
		return saved && task.getSaved() === saved ? saved as Saved : null;
	}, [task, me?.user?.role]);
	const acceptReady = useCallback((run: UploadRun, sessionId: string, generation: number) => {
		if (run.controller.signal.aborted || !isCurrentRun(run.token) || !task.acceptReady(run, sessionId, generation)) return false;
		if (task.matchesOperation(identity)) return isCurrentRun(run.token);
		latest.current.onCancelError(new Error('이전 파일의 업로드가 완료되었습니다. 선택한 파일을 재시도해 주세요.'));
		return false;
	}, [task, identity, isCurrentRun]);
	// READY recovers the old job. It satisfies the selection only with source proof.
	// Claim and cleanup happen after every asynchronous check, while all owners hold.
	const acceptRestoredReady = useCallback(async (run: UploadRun, sessionId: string, generation: number, index = 0) => {
		if (!isCurrentRun(run.token)) return false;
		const chosen = runs.current.get(run.token)!;
		const saved = task.getSaved();
		if (!saved || sessionOf(saved).sessionId !== sessionId || sessionOf(saved).generation !== generation) return false;
		const file = chosen.files[index];
		const matches = file ? await task.matchesFile(file)
			: chosen.files.length === 0 && chosen.generation === 0;
		if (!isCurrentRun(run.token) || task.getSaved() !== saved) return false;
		if (!matches) throw new Error(fileVerificationMessage);
		return acceptReady(run, sessionId, generation);
	}, [task, acceptReady, isCurrentRun]);
	const transfer = useCallback(async (run: UploadRun, args: TransferArgs, toSaved: (session: DirectAssetUploadSession) => Saved) => {
		if (!isCurrentRun(run.token) || !runs.current.get(run.token)?.files.includes(args[1])) throw new Error(fileVerificationMessage);
		return task.transfer(run, args, toSaved, identity);
	}, [task, identity, isCurrentRun]);
	const cancel = useCallback(async () => {
		const spec = recoveryRef.current;
		await task.cancel(spec ? { ...spec, mode: me?.user?.role === 'USER' ? 'user' : 'admin' } : undefined);
		if (task.hasUnresolved() && !task.isPendingCreate()) await restore().catch(() => undefined);
	}, [task, restore, me?.user?.role]);
	return {
		saved: snapshot.saved as Saved | null, taskMessage: snapshot.message, handoff: snapshot.handoff,
		canContinue: snapshot.control === 'open', cancelPending: snapshot.control === 'cancelling' || snapshot.control === 'completion',
		selectFiles, getSelectedFiles, acceptRestoredReady, restore, restoreRequired, matchesFile: task.matchesFile, isPendingCreate: task.isPendingCreate, getSaved: task.getSaved as () => Saved | null,
		remember: task.remember as (saved: Saved, updateUi?: boolean) => void,
		forget: task.forget, beginRun, finishRun: task.finishRun,
		pause: task.pause, cancel,
		transfer,
		acceptReady, isMounted, isCurrentRun,
	};
}
