const MAX_OBJECT_KEY_UTF8_BYTES = 1024;

function encodePathSegment(segment: string): string {
	return encodeURIComponent(segment).replace(/[!'()*]/g, (character) => (
		`%${character.charCodeAt(0).toString(16).toUpperCase()}`
	));
}

export function normalizePublicAssetOrigin(origin: string): string {
	const parsed = new URL(origin);
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error('PUBLIC_ASSET_ORIGIN must not contain credentials, query, or fragment');
	}
	parsed.pathname = parsed.pathname.replace(/\/+$/, '');
	return parsed.toString().replace(/\/$/, '');
}

/**
 * Encode each S3 key segment without turning path separators into data. Dot
 * segments and backslashes are rejected because reverse proxies can normalize
 * them before Garage sees the signed/authorized object identity.
 */
export function publicObjectUrl(origin: string, objectKey: string): string {
	if (!objectKey || objectKey.startsWith('/') || objectKey.includes('\\') || objectKey.includes('\0')) {
		throw new Error('Public object key is empty or absolute');
	}
	if (new TextEncoder().encode(objectKey).byteLength > MAX_OBJECT_KEY_UTF8_BYTES) {
		throw new Error('Public object key exceeds 1024 UTF-8 bytes');
	}
	const segments = objectKey.split('/');
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new Error('Public object key contains an unsafe path segment');
	}
	return `${normalizePublicAssetOrigin(origin)}/${segments.map(encodePathSegment).join('/')}`;
}

export function safePublicRelativePath(requestedPath: string, rawUrl?: string): string {
	if (rawUrl) {
		let decoded = rawUrl.split('?', 1)[0] ?? '';
		try {
			for (let pass = 0; pass < 3; pass += 1) {
				const next = decodeURIComponent(decoded);
				if (next === decoded) break;
				decoded = next;
			}
		} catch {
			throw new Error('Invalid public object path');
		}
		const rawSegments = decoded.replace(/\\/g, '/').split('/');
		if (rawSegments.some((segment) => segment === '.' || segment === '..') || decoded.includes('\0')) {
			throw new Error('Invalid public object path');
		}
	}
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(requestedPath);
	} catch {
		throw new Error('Invalid public object path');
	}
	const slashPath = decodedPath.replace(/\\/g, '/');
	const segments = slashPath.split('/');
	if (!slashPath || slashPath.startsWith('/') || slashPath.includes('\0')
		|| segments.some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new Error('Invalid public object path');
	}
	return segments.join('/');
}

