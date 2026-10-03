import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import type { SelectHTMLAttributes } from 'react';
import type { Visibility } from '@pcu/contracts';
import { env } from '../lib/env';
import CustomSelect from './CustomSelect';
import { visibilityLabels, visibilityRank } from '../lib/visibility';

const VisibilityControl = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function VisibilityControl({
	className, id, value, defaultValue = '', onChange, onBlur, onInvalid, disabled, required,
	...props
}, forwardedRef) {
	const nativeRef = useRef<HTMLSelectElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [uncontrolledValue, setUncontrolledValue] = useState(String(defaultValue));
	const selectedValue = value === undefined ? uncontrolledValue : String(value);
	const attachRef = useCallback((element: HTMLSelectElement | null) => {
		nativeRef.current = element;
		if (typeof forwardedRef === 'function') forwardedRef(element);
		else if (forwardedRef) forwardedRef.current = element;
		// Register initializes the native select before its value is copied to the visible control.
		if (element && value === undefined) setUncontrolledValue(element.value);
	}, [forwardedRef, value]);

	useEffect(() => {
		const form = nativeRef.current?.form;
		if (!form) return;
		let timer: number | undefined;
		const reset = () => {
			// The browser restores defaultValue after the reset event has propagated.
			timer = window.setTimeout(() => {
				if (nativeRef.current && value === undefined) setUncontrolledValue(nativeRef.current.value);
			}, 0);
		};
		form.addEventListener('reset', reset);
		return () => { form.removeEventListener('reset', reset); window.clearTimeout(timer); };
	}, [value, props.form]);

	return <CustomSelect
		id={id}
		className={['visibility-select', className].filter(Boolean).join(' ')}
		value={selectedValue}
		disabled={disabled}
		aria-invalid={props['aria-invalid']}
		placeholder="공개 범위를 선택하세요"
		triggerRef={triggerRef}
		triggerProps={{
			'aria-label': props['aria-label'] ?? (props['aria-labelledby'] ? undefined : '공개 범위'),
			'aria-labelledby': props['aria-labelledby'],
			'aria-describedby': props['aria-describedby'],
			'aria-required': required,
			title: props.title,
			tabIndex: props.tabIndex,
			autoFocus: props.autoFocus,
			style: props.style,
		}}
		onBlur={(event) => {
			if ((event.target as Node) !== nativeRef.current && !event.currentTarget.contains(event.relatedTarget)) {
				nativeRef.current?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
			}
		}}
		onChange={(nextValue) => {
			const native = nativeRef.current;
			if (!native || native.matches(':disabled')) return;
			native.value = String(nextValue);
			native.dispatchEvent(new Event('change', { bubbles: true }));
		}}
		items={Object.entries(visibilityLabels).map(([value, label]) => ({ value, label, searchText: label }))}
	>
		<select
			{...props}
			ref={attachRef}
			value={value}
			defaultValue={value === undefined ? defaultValue : undefined}
			disabled={disabled}
			required={required}
			aria-hidden="true"
			tabIndex={-1}
			autoFocus={false}
			style={undefined}
			className="visibility-select__native"
			onFocus={() => triggerRef.current?.focus()}
			onChange={(event) => {
				if (value === undefined) setUncontrolledValue(event.target.value);
				onChange?.(event);
			}}
			onBlur={onBlur}
			onInvalid={(event) => {
				event.preventDefault();
				triggerRef.current?.focus();
				onInvalid?.(event);
			}}
		>
			<option value="" disabled>공개 범위를 선택하세요</option>
			{Object.entries(visibilityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
		</select>
	</CustomSelect>;
});

export const VisibilitySelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function VisibilitySelect(props, ref) {
	if (!env.VISIBILITY_CONTROLS_ENABLED) return null;
	return <VisibilityControl {...props} ref={ref} />;
});

export function VisibilityNotice({ visibility, exhibitionVisibility }: { visibility?: Visibility; exhibitionVisibility?: Visibility }) {
	if (!env.VISIBILITY_CONTROLS_ENABLED || !exhibitionVisibility || visibilityRank[visibility ?? 'PUBLIC'] >= visibilityRank[exhibitionVisibility]) return null;
	return <p className="field-hint">작품의 실제 공개 범위는 전시회의 공개 범위({visibilityLabels[exhibitionVisibility]})를 따릅니다.</p>;
}
