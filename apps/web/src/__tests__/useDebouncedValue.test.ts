// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from '../lib/useDebouncedValue';

describe('useDebouncedValue', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns the initial value synchronously on first render', () => {
		const { result } = renderHook(() => useDebouncedValue('a', 250));
		expect(result.current).toBe('a');
	});

	it('defers updates until delayMs of quiet has elapsed', () => {
		const { result, rerender } = renderHook(
			({ value }: { value: string }) => useDebouncedValue(value, 250),
			{ initialProps: { value: 'a' } },
		);

		rerender({ value: 'b' });
		act(() => { vi.advanceTimersByTime(249); });
		expect(result.current).toBe('a');

		act(() => { vi.advanceTimersByTime(1); });
		expect(result.current).toBe('b');
	});

	it('collapses a burst of changes to the last value', () => {
		const { result, rerender } = renderHook(
			({ value }: { value: string }) => useDebouncedValue(value, 250),
			{ initialProps: { value: 'a' } },
		);

		rerender({ value: 'b' });
		act(() => { vi.advanceTimersByTime(100); });
		rerender({ value: 'c' });
		act(() => { vi.advanceTimersByTime(100); });
		rerender({ value: 'd' });
		// A full 250ms of quiet only elapses after the last rerender.
		expect(result.current).toBe('a');
		act(() => { vi.advanceTimersByTime(250); });
		expect(result.current).toBe('d');
	});

	it('does not fire the debounce timer while freeze is true', () => {
		const { result, rerender } = renderHook(
			({ value, freeze }: { value: string; freeze: boolean }) =>
				useDebouncedValue(value, 250, freeze),
			{ initialProps: { value: 'a', freeze: true } },
		);

		rerender({ value: 'b', freeze: true });
		act(() => { vi.advanceTimersByTime(1000); });
		expect(result.current).toBe('a');
	});

	it('resumes debounce after freeze flips false with the latest value', () => {
		const { result, rerender } = renderHook(
			({ value, freeze }: { value: string; freeze: boolean }) =>
				useDebouncedValue(value, 250, freeze),
			{ initialProps: { value: 'a', freeze: false } },
		);

		// Enter composition, change value several times — debounced stays at 'a'.
		rerender({ value: 'a', freeze: true });
		rerender({ value: 'ㄱ', freeze: true });
		rerender({ value: '가', freeze: true });
		act(() => { vi.advanceTimersByTime(1000); });
		expect(result.current).toBe('a');

		// Composition ends; normal debounce resumes with the latest value.
		rerender({ value: '가', freeze: false });
		act(() => { vi.advanceTimersByTime(250); });
		expect(result.current).toBe('가');
	});
});
