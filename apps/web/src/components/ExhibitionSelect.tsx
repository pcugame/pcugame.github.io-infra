import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AdminYearItem } from '../contracts';

interface Props {
	id?: string;
	value: number | null;
	onChange: (id: number) => void;
	items: AdminYearItem[];
	disabled?: boolean;
	'aria-invalid'?: boolean;
}

export default function ExhibitionSelect({
	id,
	value,
	onChange,
	items,
	disabled,
	'aria-invalid': ariaInvalid,
}: Props) {
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState<number>(-1);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLUListElement>(null);
	const typeaheadRef = useRef<{ buffer: string; timer: number | null }>({ buffer: '', timer: null });
	const autoId = useId();
	const listboxId = `${id ?? 'exhibition-select'}-list-${autoId}`;

	const selectedIndex = useMemo(
		() => items.findIndex((it) => it.id === value),
		[items, value],
	);
	const selected = selectedIndex >= 0 ? items[selectedIndex] : null;

	const openPanel = useCallback(() => {
		if (disabled) return;
		setOpen(true);
		setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
	}, [disabled, selectedIndex]);

	const closePanel = useCallback((restoreFocus = true) => {
		setOpen(false);
		setActiveIndex(-1);
		if (restoreFocus) triggerRef.current?.focus();
	}, []);

	const commit = useCallback(
		(index: number) => {
			const item = items[index];
			if (!item) return;
			onChange(item.id);
			closePanel();
		},
		[items, onChange, closePanel],
	);

	// Close on outside pointerdown
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) {
				setOpen(false);
				setActiveIndex(-1);
			}
		};
		document.addEventListener('mousedown', onPointerDown);
		return () => document.removeEventListener('mousedown', onPointerDown);
	}, [open]);

	// Scroll active option into view
	useEffect(() => {
		if (!open || activeIndex < 0 || !listRef.current) return;
		const el = listRef.current.querySelector<HTMLLIElement>(
			`[data-index="${activeIndex}"]`,
		);
		el?.scrollIntoView({ block: 'nearest' });
	}, [open, activeIndex]);

	const handleTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			openPanel();
		}
	};

	const handleListKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			closePanel();
			return;
		}
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			if (activeIndex >= 0) commit(activeIndex);
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setActiveIndex((i) => Math.min(items.length - 1, i + 1));
			return;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			setActiveIndex((i) => Math.max(0, i - 1));
			return;
		}
		if (e.key === 'Home') {
			e.preventDefault();
			setActiveIndex(0);
			return;
		}
		if (e.key === 'End') {
			e.preventDefault();
			setActiveIndex(items.length - 1);
			return;
		}
		if (e.key === 'Tab') {
			closePanel(false);
			return;
		}
		// Type-ahead: match by year digits or title prefix
		if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
			const t = typeaheadRef.current;
			t.buffer = (t.buffer + e.key).toLowerCase();
			if (t.timer != null) window.clearTimeout(t.timer);
			t.timer = window.setTimeout(() => {
				t.buffer = '';
				t.timer = null;
			}, 600);
			const match = items.findIndex((it) => {
				const hay = `${it.year} ${it.title ?? ''}`.toLowerCase();
				return hay.startsWith(t.buffer) || String(it.year).startsWith(t.buffer);
			});
			if (match >= 0) setActiveIndex(match);
		}
	};

	// Focus the listbox when opened so keyboard events work immediately
	useEffect(() => {
		if (open) listRef.current?.focus();
	}, [open]);

	const renderLabel = (it: AdminYearItem) => (
		<>
			<span className="exhibition-select__year">{it.year}</span>
			<span className="exhibition-select__sep" aria-hidden="true">
				{it.title ? '—' : ''}
			</span>
			<span className="exhibition-select__title">{it.title ?? ''}</span>
			{!it.isUploadEnabled && (
				<span className="exhibition-select__lock-pill">업로드 잠김</span>
			)}
		</>
	);

	return (
		<div className="exhibition-select" ref={rootRef}>
			<button
				id={id}
				ref={triggerRef}
				type="button"
				className={
					'exhibition-select__trigger' +
					(selected ? '' : ' exhibition-select__trigger--placeholder')
				}
				role="combobox"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={listboxId}
				aria-invalid={ariaInvalid || undefined}
				disabled={disabled}
				onClick={() => (open ? closePanel(false) : openPanel())}
				onKeyDown={handleTriggerKey}
			>
				<span className="exhibition-select__trigger-label">
					{selected ? renderLabel(selected) : '전시회를 선택하세요'}
				</span>
				<svg
					className="exhibition-select__chevron"
					width="14"
					height="14"
					viewBox="0 0 20 20"
					fill="none"
					aria-hidden="true"
				>
					<path
						d="M5 7.5 10 12.5 15 7.5"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>

			{open && (
				<ul
					id={listboxId}
					ref={listRef}
					className="exhibition-select__panel"
					role="listbox"
					tabIndex={-1}
					aria-activedescendant={
						activeIndex >= 0 ? `${listboxId}-opt-${items[activeIndex].id}` : undefined
					}
					onKeyDown={handleListKey}
				>
					{items.map((it, index) => {
						const isSelected = it.id === value;
						const isActive = index === activeIndex;
						return (
							<li
								key={it.id}
								id={`${listboxId}-opt-${it.id}`}
								role="option"
								aria-selected={isSelected}
								data-index={index}
								data-active={isActive || undefined}
								className="exhibition-select__option"
								onMouseEnter={() => setActiveIndex(index)}
								onMouseDown={(e) => {
									// prevent blur before click
									e.preventDefault();
								}}
								onClick={() => commit(index)}
							>
								{renderLabel(it)}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
