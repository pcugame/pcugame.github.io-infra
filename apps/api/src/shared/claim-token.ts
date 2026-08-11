/**
 * Generate an opaque, process-local claim token when a caller did not inject an
 * application IdGenerator. Production composition injects one; the fallback
 * keeps isolated service tests and recovery tooling usable.
 */
export function createClaimToken(): string {
	const cryptoApi = globalThis.crypto;
	if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
		return cryptoApi.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
