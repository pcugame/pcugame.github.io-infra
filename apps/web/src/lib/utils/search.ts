function normalizeSearchText(value: string | number | null | undefined): string {
	return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

function compactSearchText(value: string | number | null | undefined): string {
	return normalizeSearchText(value).replace(/\s+/g, '');
}

export function matchesSearch(values: Array<string | number | null | undefined>, query: string): boolean {
	const normalizedQuery = normalizeSearchText(query);
	if (!normalizedQuery) return true;

	const normalizedHaystack = normalizeSearchText(values.join(' '));
	const compactQuery = compactSearchText(query);
	const compactHaystack = compactSearchText(values.join(''));

	if (normalizedHaystack.includes(normalizedQuery) || compactHaystack.includes(compactQuery)) {
		return true;
	}

	const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
	return tokens.length > 1 && tokens.every((token) => {
		const compactToken = compactSearchText(token);
		return normalizedHaystack.includes(token) || compactHaystack.includes(compactToken);
	});
}
