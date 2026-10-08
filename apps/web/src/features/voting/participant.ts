const COOKIE = 'pcu_vote_participant';
function stored(): string | null {
	const value = document.cookie
		.split(';')
		.map((v) => v.trim())
		.find((v) => v.startsWith(COOKIE + '='))
		?.slice(COOKIE.length + 1);
	return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
/** Web Locks serialize first creation across tabs. Never silently fall back to an unstable identity. */
export async function votingIdentity(): Promise<string> {
	if (!navigator.locks) {
		const existing = stored();
		if (existing) return existing;
		throw new Error('참여 정보 저장을 지원하는 최신 브라우저에서 열어 주세요.');
	}
	return navigator.locks.request('pcu-voting-identity', () => {
		const existing = stored();
		if (existing) return existing;
		const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
			n.toString(16).padStart(2, '0'),
		).join('');
		document.cookie = `${COOKIE}=${token}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
		if (stored() !== token)
			throw new Error('쿠키 저장이 차단되어 참여 정보를 보존할 수 없습니다. 브라우저 설정을 확인해 주세요.');
		return token;
	});
}
export async function votingHeaders() {
	return { 'X-Vote-Participant': await votingIdentity() };
}
export function stableCandidateOrder(ids: string[], previous: string[] = []): string[] {
	const present = new Set(ids),
		old = new Set(previous);
	const added = ids.filter((id) => !old.has(id));
	for (let i = added.length - 1; i > 0; i--) {
		const n = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
		[added[i], added[n]] = [added[n]!, added[i]!];
	}
	return [...previous.filter((id) => present.has(id)), ...added];
}
