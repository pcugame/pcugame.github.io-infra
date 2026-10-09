import { useEffect, useRef, type ReactNode } from 'react';
export function ConfirmVoteDialog({
	titleId,
	children,
	onClose,
	busy,
}: {
	titleId: string;
	children: ReactNode;
	onClose: () => void;
	busy: boolean;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current!;
		dialog.showModal();
		return () => dialog.close();
	}, []);
	return (
		<dialog
			ref={ref}
			aria-labelledby={titleId}
			className="vote-confirm"
			onCancel={(e) => {
				e.preventDefault();
				if (!busy) onClose();
			}}
		>
			{children}
		</dialog>
	);
}
