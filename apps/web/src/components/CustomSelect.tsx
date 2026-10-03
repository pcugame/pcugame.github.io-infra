import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, FocusEventHandler, ReactNode, RefObject } from 'react';

interface SelectItem {
	value: string | number;
	label: ReactNode;
	searchText: string;
}
interface Props {
	id?: string;
	value: string | number | null;
	onChange: (value: string | number) => void;
	items: SelectItem[];
	placeholder: string;
	disabled?: boolean;
	'aria-invalid'?: ButtonHTMLAttributes<HTMLButtonElement>['aria-invalid'];
	children?: ReactNode;
	className?: string;
	triggerProps?: ButtonHTMLAttributes<HTMLButtonElement>;
	triggerRef?: RefObject<HTMLButtonElement | null>;
	onBlur?: FocusEventHandler<HTMLDivElement>;
}

export default function CustomSelect({
	id, value, onChange, items, placeholder, disabled,
	'aria-invalid': ariaInvalid, className, children, triggerProps,
	triggerRef: externalTriggerRef, onBlur,
}: Props) {
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState<number>(-1);
	const rootRef = useRef<HTMLDivElement>(null);
	const internalTriggerRef = useRef<HTMLButtonElement>(null);
	const triggerRef = externalTriggerRef ?? internalTriggerRef;
	const listRef = useRef<HTMLUListElement>(null);
	const typeaheadRef = useRef<{ buffer: string; timer: number | null }>({ buffer: '', timer: null });
	const autoId = useId();
	const triggerId = `custom-select-${autoId}`;
	const listboxId = `${id ?? 'custom-select'}-list-${autoId}`;

	const selectedIndex = useMemo(
		() => items.findIndex((it) => it.value === value),
		[items, value],
	);
	const selected = selectedIndex >= 0 ? items[selectedIndex] : null;

	const openPanel = useCallback(() => {
		if (disabled || triggerRef.current?.matches(':disabled')) return;
		setOpen(true);
		setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
	}, [disabled, selectedIndex, triggerRef]);

	const closePanel = useCallback((restoreFocus = true) => {
		setOpen(false);
		setActiveIndex(-1);
		if (restoreFocus) triggerRef.current?.focus();
	}, [triggerRef]);

	const commit = useCallback(
		(index: number) => {
			const item = items[index];
			if (!item || disabled || triggerRef.current?.matches(':disabled')) return;
			onChange(item.value);
			closePanel();
		},
		[items, onChange, closePanel, disabled, triggerRef],
	);

	// Close on outside pointerdown
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) {
				setOpen(false);
				setActiveIndex(-1);
			}
		};
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	}, [open]);

	// Scroll active option into view
	useEffect(() => {
		if (!open || activeIndex < 0 || !listRef.current) return;
		const el = listRef.current.querySelector<HTMLLIElement>(
			`[data-index="${activeIndex}"]`,
		);
		el?.scrollIntoView?.({ block: 'nearest' });
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
			triggerRef.current?.focus();
			closePanel(false);
			return;
		}
		// Type-ahead uses the item text supplied by each select.
		if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
			const t = typeaheadRef.current;
			t.buffer = (t.buffer + e.key).toLowerCase();
			if (t.timer != null) window.clearTimeout(t.timer);
			t.timer = window.setTimeout(() => {
				t.buffer = '';
				t.timer = null;
			}, 600);
			const match = items.findIndex((it) => it.searchText.toLowerCase().startsWith(t.buffer));
			if (match >= 0) setActiveIndex(match);
		}
	};

	// Focus the listbox when opened so keyboard events work immediately
	useEffect(() => {
		if (open) listRef.current?.focus();
	}, [open]);

	useEffect(() => {
		const typeahead = typeaheadRef.current;
		return () => { if (typeahead.timer != null) window.clearTimeout(typeahead.timer); };
	}, []);

	return (
		<div className={['exhibition-select', className].filter(Boolean).join(' ')} ref={rootRef} onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) closePanel(false);
				onBlur?.(event);
			}}>
			{children}
			<button
				id={id ?? triggerId}
				{...triggerProps}
				ref={triggerRef}
				type="button"
				className={
					'exhibition-select__trigger' +
					(selected ? '' : ' exhibition-select__trigger--placeholder')
				}
				role="combobox"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listboxId : undefined}
				aria-invalid={ariaInvalid || undefined}
				disabled={disabled}
				onClick={() => (open ? closePanel(false) : openPanel())}
				onKeyDown={handleTriggerKey}
			>
				<span className="exhibition-select__trigger-label">
					{selected ? selected.label : placeholder}
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

			{open && !disabled && (
				<ul
					id={listboxId}
					ref={listRef}
					className="exhibition-select__panel"
					role="listbox"
					aria-labelledby={id ?? triggerId}
					tabIndex={-1}
					aria-activedescendant={
						items[activeIndex] ? `${listboxId}-opt-${items[activeIndex]?.value}` : undefined
					}
					onKeyDown={handleListKey}
				>
					{items.map((it, index) => {
						const isSelected = it.value === value;
						const isActive = index === activeIndex;
						return (
							<li
								key={it.value}
								id={`${listboxId}-opt-${it.value}`}
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
								{it.label}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
