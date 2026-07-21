export interface SessionSourceHeaders {
	origin?: string | string[];
	referer?: string | string[];
}

function firstHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/**
 * Bind browser cookie sessions to the configured frontend origins.
 *
 * Hosted WebGL runs on the API origin so Unity can use IndexedDB, but uploaded
 * JavaScript must never be able to reuse an administrator's API cookie. Browser
 * fetches from the frontend carry Origin, while navigations/downloads carry
 * Referer. Requests with neither are intentionally treated as anonymous.
 */
export function isAllowedSessionSource(
	headers: SessionSourceHeaders,
	allowedOrigins: ReadonlySet<string>,
): boolean {
	const origin = firstHeader(headers.origin);
	if (origin) return allowedOrigins.has(origin);

	const referer = firstHeader(headers.referer);
	if (!referer) return false;
	try {
		return allowedOrigins.has(new URL(referer).origin);
	} catch {
		return false;
	}
}
