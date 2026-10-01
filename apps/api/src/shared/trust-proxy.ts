/** Trust explicit proxy addresses, never a number of forwarding hops. */
export function parseTrustProxy(value: string): boolean | string {
	const normalized = value.trim();
	if (normalized === 'true') return true;
	if (normalized === 'false' || normalized === '') return false;
	if (!Number.isNaN(Number(normalized))) {
		throw new Error('TRUST_PROXY numeric hop counts are unsupported; use false or the exact trusted proxy peer IP/CIDR (as observed by the API).');
	}
	return normalized;
}
