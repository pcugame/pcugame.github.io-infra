import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../../components/ui';

/** Keep the dialog's upload children mounted when closed; only settings drafts reset. */
export function ExhibitionSettingsDialog({
	id,
	open,
	busy,
	onClose,
	children,
}: {
	id: number;
	open: boolean;
	busy: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const element = dialog.current;
		if (!element || !open) return;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		element.showModal();
		element.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
		element.scrollTop = 0;
		return () => {
			element.close();
			document.body.style.overflow = previousOverflow;
		};
	}, [open]);
	return createPortal(
		<dialog
			ref={dialog}
			id={`exhibition-panel-${id}`}
			className="exhibition-dialog"
			aria-labelledby={`exhibition-dialog-title-${id}`}
			onCancel={(event) => {
				if (event.target !== event.currentTarget) return;
				event.preventDefault();
				if (!busy) onClose();
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget && !busy) onClose();
			}}
		>
			<header className="exhibition-dialog__header">
				<div>
					<h2 tabIndex={-1} id={`exhibition-dialog-title-${id}`}>전시회 설정</h2>
					<p>전시회 정보와 포스터를 관리합니다.</p>
				</div>
				<Button
					variant="secondary"
					aria-label="설정 창 닫기"
					onClick={onClose}
					disabled={busy}
				>
					닫기
				</Button>
			</header>
			<div className="exhibition-dialog__body">{children}</div>
		</dialog>,
		document.body,
	);
}
