// All messages persisted or logged from this boundary use fixed, non-secret codes.
export class LabFailure extends Error {
	constructor(
		readonly code: string,
		readonly retryable = false,
	) {
		super(code);
	}
}

export async function requestJson(url: string | URL, options: RequestInit, maxBytes: number): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, { ...options, redirect: 'error' });
	} catch {
		throw new LabFailure('PROVIDER_UNREACHABLE', true);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new LabFailure(`PROVIDER_HTTP_${response.status}`, response.status === 429 || response.status >= 500);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new LabFailure('PROVIDER_EMPTY_RESPONSE');
	const parts: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > maxBytes) throw new LabFailure('PROVIDER_RESPONSE_TOO_LARGE');
			parts.push(chunk.value);
		}
		return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		if (error instanceof LabFailure) throw error;
		throw new LabFailure('PROVIDER_INVALID_RESPONSE', true);
	} finally {
		reader.releaseLock();
	}
}

export function jsonHeaders(key?: string): Record<string, string> {
	return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}
