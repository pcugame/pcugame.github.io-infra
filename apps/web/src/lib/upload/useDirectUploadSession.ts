import { useCallback, useEffect, useRef, useState } from 'react';
import {
	cancelDirectAssetUploadSession, getDirectAssetUploadStatus, uploadDirectAssetFile,
	type DirectAssetUploadSession,
} from '../api/game-upload';

export type UploadRun = { token: number; controller: AbortController };
// Existing callers persist either the bare session or a session plus queue metadata.
type Locator = DirectAssetUploadSession | { session: DirectAssetUploadSession };
type SessionStatus = Awaited<ReturnType<typeof getDirectAssetUploadStatus>>;
function sessionOf(value: Locator): DirectAssetUploadSession {
	return 'session' in value ? value.session : value;
}
type TransferArgs = Parameters<typeof uploadDirectAssetFile>;

/**
 * Owns one widget's locator, request lifetime and cancellation intent.
 * The caller owns file matching, queue offsets, readiness polling and presentation.
 * Pause/dispose abort local work only. Cancel also settles pending creates before
 * notifying the caller; a late create must still reach transfer's onSession.
 * Keep the existing storage key/shape and key the consuming component by owner/kind.
 * Queue-level completion notification remains the caller's responsibility.
 */
export function useDirectUploadSession<Saved extends Locator>({
	storageKey, onCancelled, onCancelReady, onCancelError, onCancelSettled,
}: {
	storageKey: string;
	onCancelled?: () => void;
	// Report the observed server state; the caller decides whether polling is needed.
	onCancelReady: (saved: Saved, state: 'READY' | 'COMPLETING' | 'VERIFYING', status: SessionStatus) => void;
	onCancelError: (cause: unknown, terminalState?: 'REJECTED' | 'EXPIRED', status?: SessionStatus) => void;
	onCancelSettled: () => void;
}) {
	const [saved, setSaved] = useState<Saved | null>(null);
	const locator = useRef<Saved | null>(null);
	const mounted = useRef(false);
	const serial = useRef(0);
	const active = useRef<UploadRun | null>(null);
	const paused = useRef<number | null>(null);
	const pendingCreates = useRef(new Set<number>());
	const cancelledCreates = useRef(new Set<number>());
	const deleting = useRef(new Set<string>());
	const cancellationIntent = useRef(false);
	const accepted = useRef(new Set<string>());
	const callbacks = useRef({ onCancelled, onCancelReady, onCancelError, onCancelSettled });
	useEffect(() => {
		callbacks.current = { onCancelled, onCancelReady, onCancelError, onCancelSettled };
	}, [onCancelled, onCancelReady, onCancelError, onCancelSettled]);

	const isMounted = useCallback(() => mounted.current, []);
	const getSaved = useCallback(() => locator.current, []);
	const remember = useCallback((value: Saved, updateUi = true) => {
		locator.current = value;
		window.sessionStorage.setItem(storageKey, JSON.stringify(value));
		if (updateUi && mounted.current) setSaved(value);
	}, [storageKey]);
	const forget = useCallback((expectedSessionId: string) => {
		if (!locator.current || sessionOf(locator.current).sessionId !== expectedSessionId) return false;
		const previous = locator.current;
		locator.current = null;
		// An old mounted instance must not delete a newer instance's locator.
		const raw = window.sessionStorage.getItem(storageKey);
		if (raw === JSON.stringify(previous)) {
			window.sessionStorage.removeItem(storageKey);
		}
		if (mounted.current) setSaved(null);
		return true;
	}, [storageKey]);
	const isCurrentRun = useCallback((token: number) => mounted.current && active.current?.token === token, []);
	const finishCancellation = useCallback(() => {
		if (pendingCreates.current.size || cancelledCreates.current.size || deleting.current.size || locator.current) return;
		if (cancellationIntent.current && mounted.current) {
			cancellationIntent.current = false;
			callbacks.current.onCancelled?.();
		}
	}, []);
	const beginRun = useCallback(() => {
		if (!mounted.current || active.current || cancelledCreates.current.size || deleting.current.size) return null;
		cancellationIntent.current = false;
		paused.current = null;
		const run = { token: ++serial.current, controller: new AbortController() };
		active.current = run;
		return run;
	}, []);
	const finishRun = useCallback((token: number) => {
		if (active.current?.token === token) active.current = null;
	}, []);
	const abort = useCallback(() => {
		const run = active.current;
		active.current = null;
		serial.current += 1;
		run?.controller.abort();
	}, []);
	const pause = useCallback(() => {
		paused.current = active.current?.token ?? null;
		abort();
	}, [abort]);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			abort();
		};
	}, [abort, storageKey]);

	// A READY result may be observed by upload, restore, polling and DELETE recovery.
	// Claim it before invoking queue callbacks, even when those callbacks re-render.
	const acceptReady = useCallback((run: UploadRun, sessionId: string, generation: number) => {
		const key = `${sessionId}:${generation}`;
		if (!isCurrentRun(run.token) || accepted.current.has(key)) return false;
		const current = locator.current ? sessionOf(locator.current) : null;
		if (current && (current.sessionId !== sessionId || current.generation !== generation)) return false;
		accepted.current.add(key);
		forget(sessionId);
		return true;
	}, [forget, isCurrentRun]);

	const cancelSession = useCallback(async (candidate: Saved) => {
		const { sessionId, generation, owner, kind } = sessionOf(candidate);
		if (deleting.current.has(sessionId)) return;
		deleting.current.add(sessionId);
		const cancelSerial = serial.current;
		const current = () => mounted.current && serial.current === cancelSerial
			&& locator.current !== null && sessionOf(locator.current).sessionId === sessionId;
		let ready: { state: 'READY' | 'COMPLETING' | 'VERIFYING'; status: SessionStatus } | null = null;
		try {
			await cancelDirectAssetUploadSession(sessionId);
			const notify = current();
			forget(sessionId);
			if (notify) callbacks.current.onCancelSettled();
		} catch (cause) {
			try {
				const status = await getDirectAssetUploadStatus(sessionId);
				if (!current()) return;
				if (status.sessionId !== sessionId || status.generation !== generation
					|| status.kind !== kind || status.owner.type !== owner.type || status.owner.id !== owner.id) {
					callbacks.current.onCancelError(cause);
					return;
				}
				if (status.state === 'CANCELLED') {
					forget(sessionId);
					callbacks.current.onCancelSettled();
				} else if (status.state === 'READY' || status.state === 'COMPLETING' || status.state === 'VERIFYING') {
					cancellationIntent.current = false;
					ready = { state: status.state, status };
				} else callbacks.current.onCancelError(cause, status.state === 'REJECTED' || status.state === 'EXPIRED' ? status.state : undefined, status);
			} catch {
				if (current()) callbacks.current.onCancelError(cause);
			}
		} finally {
			deleting.current.delete(sessionId);
			finishCancellation();
			if (ready && current()) callbacks.current.onCancelReady(candidate, ready.state, ready.status);
		}
	}, [finishCancellation, forget]);
	const cancel = useCallback(async () => {
		if (deleting.current.size || cancelledCreates.current.size) return;
		cancellationIntent.current = true;
		for (const token of pendingCreates.current) cancelledCreates.current.add(token);
		paused.current = null;
		abort();
		const candidate = locator.current;
		if (candidate) await cancelSession(candidate);
		else finishCancellation();
	}, [abort, cancelSession, finishCancellation]);

	/** Client owns transport/retries; this hook owns callbacks and late-create cleanup. */
	const transfer = useCallback(async (
		run: UploadRun,
		args: TransferArgs,
		toSaved: (session: DirectAssetUploadSession) => Saved,
	) => {
		const [owner, file, kind, onProgress, options = {}] = args;
		if (!options.resume) pendingCreates.current.add(run.token);
		let received = false;
		try {
			return await uploadDirectAssetFile(owner, file, kind, (progress) => {
				if (isCurrentRun(run.token)) onProgress?.(progress);
			}, {
				...options, signal: run.controller.signal,
				onSession: (session) => {
					if (received) return;
					received = true;
					pendingCreates.current.delete(run.token);
					const cancelRequested = cancelledCreates.current.delete(run.token);
					const current = isCurrentRun(run.token);
					const isPaused = paused.current === run.token && !active.current && mounted.current;
					const candidate = toSaved(session);
					if (current || isPaused || cancelRequested) remember(candidate);
					else if (!locator.current && !window.sessionStorage.getItem(storageKey)) remember(candidate, false);
					if (cancelRequested) void cancelSession(candidate);
				},
			});
		} finally {
			pendingCreates.current.delete(run.token);
			cancelledCreates.current.delete(run.token);
			finishCancellation();
		}
	}, [cancelSession, finishCancellation, isCurrentRun, remember, storageKey]);

	return { saved, getSaved, remember, forget, isMounted, beginRun, isCurrentRun, finishRun, pause, cancel, transfer, acceptReady };
}
