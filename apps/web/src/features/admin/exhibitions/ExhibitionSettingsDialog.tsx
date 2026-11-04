import { DialogFrame, DialogHeader, DialogBody } from '../../../components/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../../components/ui';
import type { AdminExhibitionItem } from '../../../contracts';
import { visibilityLabels } from '../../../lib/visibility';
import { env } from '../../../lib/env';

const tabs = [
	{ id: 'info', label: '기본 정보', hint: '제목 · 공개 범위 · 등록 권한' },
	{ id: 'poster', label: '포스터', hint: '대표 이미지 업로드 및 교체' },
	{ id: 'awards', label: '상 및 수상작', hint: '상 구성 · 수상 작품 선택' },
	{ id: 'delete', label: '삭제 관리', hint: '전시회와 등록 작품 삭제' },
] as const;
type Tab = (typeof tabs)[number]['id'];

/** Hidden panels stay mounted so tab changes and closing do not interrupt uploads. */
export function ExhibitionSettingsDialog({
	year,
	open,
	busy,
	onClose,
	children,
	poster,
	awards,
	danger,
}: {
	year: AdminExhibitionItem;
	open: boolean;
	busy: boolean;
	onClose: () => void;
	children: ReactNode;
	poster: ReactNode;
	awards: ReactNode;
	danger: ReactNode;
}) {
	const { id } = year;
	const dialog = useRef<HTMLDialogElement>(null);
	const [active, setActive] = useState<Tab>('info');
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
	const panels: Record<Tab, ReactNode> = {
		info: children,
		poster,
		awards,
		delete: danger,
	};
	return createPortal(
		<DialogFrame size="lg"
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
			<DialogHeader className="exhibition-dialog__header">
				<div className="exhibition-dialog__identity">
					<div className="exhibition-dialog__title-row">
						<span className="admin-year-badge">{year.year}</span>
						<h2 tabIndex={-1} id={`exhibition-dialog-title-${id}`}>
							{year.title || '제목 없는 전시회'}
						</h2>
					</div>
					<dl className="exhibition-dialog__facts">
						{env.VISIBILITY_CONTROLS_ENABLED && (
							<div>
								<dt>공개 범위</dt>
								<dd>{visibilityLabels[year.visibility]}</dd>
							</div>
						)}
						<div>
							<dt>등록 작품</dt>
							<dd>{year.projectCount}개</dd>
						</div>
						<div>
							<dt>작품 등록·변경</dt>
							<dd>
								{(year.isModificationEnabled ?? year.isUploadEnabled)
									? '허용'
									: '비허용'}
							</dd>
						</div>
					</dl>
				</div>
				<Button
					variant="secondary"
					aria-label="설정 창 닫기"
					onClick={onClose}
					disabled={busy}
				>
					닫기
				</Button>
			</DialogHeader>
			<div className="exhibition-dialog__body">
				<div
					className="exhibition-dialog__tabs"
					role="tablist"
					aria-label="전시회 세부 설정"
					aria-orientation="horizontal"
				>
					{tabs.map((tab, index) => (
						<Button
							key={tab.id}
							variant="secondary"
							role="tab"
							id={`exhibition-${id}-tab-${tab.id}`}
							aria-controls={`exhibition-${id}-section-${tab.id}`}
							aria-selected={active === tab.id}
							tabIndex={active === tab.id ? 0 : -1}
							className="exhibition-dialog__tab"
							disabled={busy}
							onClick={() => setActive(tab.id)}
							onKeyDown={(event) => {
								const next = 'ArrowRight';
								const previous = 'ArrowLeft';
								const target =
									event.key === 'Home'
										? 0
										: event.key === 'End'
											? tabs.length - 1
											: event.key === next
												? (index + 1) % tabs.length
												: event.key === previous
													? (index + tabs.length - 1) % tabs.length
													: -1;
								if (target < 0) return;
								event.preventDefault();
								setActive(tabs[target].id);
								dialog.current
									?.querySelector<HTMLElement>(
										`#exhibition-${id}-tab-${tabs[target].id}`,
									)
									?.focus();
							}}
						>
							<span>{tab.label}</span>
							<small>{tab.hint}</small>
						</Button>
					))}
				</div>
				<DialogBody className="exhibition-dialog__content">
					{tabs.map((tab) => (
						<section
							key={tab.id}
							role="tabpanel"
							id={`exhibition-${id}-section-${tab.id}`}
							aria-labelledby={`exhibition-${id}-tab-${tab.id}`}
							hidden={active !== tab.id}
							tabIndex={0}
						>
							{panels[tab.id]}
						</section>
					))}
				</DialogBody>
			</div>
		</DialogFrame>,
		document.body,
	);
}
