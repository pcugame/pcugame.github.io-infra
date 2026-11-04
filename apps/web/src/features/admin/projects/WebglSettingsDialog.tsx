import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, DialogFrame, DialogHeader, DialogBody } from '../../../components/ui';

/** Keep the settings form mounted so closing the dialog preserves unsaved input. */
export function WebglSettingsDialog({ open, busy, onClose, children }: {
	open: boolean; busy: boolean; onClose: () => void; children: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	useEffect(() => {
		const element = dialog.current;
		if (!element || !open) return;
		const previousFocus = document.activeElement as HTMLElement | null;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		element.showModal();
		element.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
		return () => {
			element.close();
			document.body.style.overflow = previousOverflow;
			if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
		};
	}, [open]);
	return createPortal(<DialogFrame size="md" ref={dialog} className="webgl-settings-dialog" aria-labelledby={titleId}
		onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
		onClick={event => {
			if (event.target !== event.currentTarget || busy) return;
			const bounds = event.currentTarget.getBoundingClientRect();
			if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
		}}>
		<DialogHeader className="webgl-settings-dialog__header">
			<h2 id={titleId} tabIndex={-1}>웹 빌드 설정</h2>
			<Button variant="secondary" size="small" disabled={busy} onClick={onClose} aria-label="웹 빌드 설정 닫기">닫기</Button>
		</DialogHeader>
		<DialogBody className="webgl-settings-dialog__body">{children}</DialogBody>
	</DialogFrame>, document.body);
}
