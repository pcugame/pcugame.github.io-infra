/** Only storage PUTs use XHR; control requests retain the JSON client. */
export async function putUploadPart(
	capability: { url: string; requiredHeaders: Record<string, string> },
	body: Blob,
	signal?: AbortSignal,
	onProgress?: (bytes: number) => void,
): Promise<{ ok: boolean; status: number; headers: Pick<Headers, 'get'> }> {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
	if (import.meta.env.VITE_MOCK === 'true') {
		const { mockFetch } = await import('./mock/transport');
		onProgress?.(0);
		const response = await mockFetch(capability.url, { method: 'PUT', headers: capability.requiredHeaders, body, signal });
		if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
		if (response.ok) onProgress?.(body.size);
		return response;
	}
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const cleanup = () => { signal?.removeEventListener('abort', abort); xhr.upload.onprogress = null; };
		const abort = () => { xhr.abort(); cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
		xhr.upload.onprogress = event => onProgress?.(Math.min(body.size, Math.max(0, event.loaded)));
		xhr.onload = () => {
			cleanup();
			resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, headers: { get: name => xhr.getResponseHeader(name) } });
		};
		xhr.onerror = xhr.ontimeout = () => { cleanup(); reject(new TypeError('UploadPart network error')); };
		xhr.onabort = () => { cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
		try {
			xhr.open('PUT', capability.url);
			for (const [name, value] of Object.entries(capability.requiredHeaders)) xhr.setRequestHeader(name, value);
			signal?.addEventListener('abort', abort, { once: true });
			if (signal?.aborted) { abort(); return; }
			xhr.send(body);
		} catch (error) { cleanup(); reject(error); }
	});
}
