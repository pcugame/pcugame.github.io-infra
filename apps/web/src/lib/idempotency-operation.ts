import { useCallback, useRef } from 'react';

export interface FileOperationFingerprint {
	name: string;
	size: number;
	type: string;
	lastModified: number;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

/** Deterministic identity for one browser-side logical mutation. */
export function createIdempotencyFingerprint(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function fingerprintFile(file: File): FileOperationFingerprint {
	return {
		name: file.name,
		size: file.size,
		type: file.type,
		lastModified: file.lastModified,
	};
}

export interface StableIdempotencyOperation {
	keyFor(fingerprint: string): string;
	complete(fingerprint: string): void;
	cancel(): void;
}

export function createStableIdempotencyOperation(
	nextKey: () => string = () => crypto.randomUUID(),
): StableIdempotencyOperation {
	let active: { fingerprint: string; key: string } | undefined;

	return {
		keyFor(fingerprint) {
			if (active?.fingerprint === fingerprint) return active.key;
			active = { fingerprint, key: nextKey() };
			return active.key;
		},
		complete(fingerprint) {
			if (active?.fingerprint === fingerprint) active = undefined;
		},
		cancel() {
			active = undefined;
		},
	};
}

export function useStableIdempotencyOperation(): StableIdempotencyOperation {
	const operation = useRef<StableIdempotencyOperation | null>(null);
	operation.current ??= createStableIdempotencyOperation();

	return {
		keyFor: useCallback((fingerprint: string) => operation.current!.keyFor(fingerprint), []),
		complete: useCallback((fingerprint: string) => operation.current!.complete(fingerprint), []),
		cancel: useCallback(() => operation.current!.cancel(), []),
	};
}
