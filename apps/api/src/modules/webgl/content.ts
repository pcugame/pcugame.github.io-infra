import { extname } from 'node:path';

export interface WebglContentMetadata {
	contentType: string;
	contentEncoding?: 'br' | 'gzip';
	cacheControl: string;
}

const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.wasm': 'application/wasm',
	'.data': 'application/octet-stream',
	'.symbols': 'application/octet-stream',
	'.unityweb': 'application/octet-stream',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.mp3': 'audio/mpeg',
	'.ogg': 'audio/ogg',
	'.wav': 'audio/wav',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
};

export function webglContentMetadata(pathname: string): WebglContentMetadata {
	const lower = pathname.toLowerCase();
	let decodedName = lower;
	let contentEncoding: WebglContentMetadata['contentEncoding'];
	if (lower.endsWith('.br')) {
		decodedName = lower.slice(0, -3);
		contentEncoding = 'br';
	} else if (lower.endsWith('.gz')) {
		decodedName = lower.slice(0, -3);
		contentEncoding = 'gzip';
	}

	const contentType = MIME_TYPES[extname(decodedName)] ?? 'application/octet-stream';
	const isHtml = contentType.startsWith('text/html');
	return {
		contentType,
		contentEncoding,
		// The public URL is stable across deployments, so resources must revalidate.
		cacheControl: isHtml
			? 'no-cache, no-store, must-revalidate'
			: 'public, max-age=300, must-revalidate',
	};
}

export function webglContentSecurityPolicy(frontendUrl: string, apiUrl: string): string {
	const frontendOrigin = new URL(frontendUrl).origin;
	const apiOrigin = new URL(apiUrl).origin;
	const webglAssetSource = `${apiOrigin}/api/public/webgl/`;
	return [
		"default-src 'none'",
		`script-src ${webglAssetSource} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`,
		`style-src ${webglAssetSource} 'unsafe-inline'`,
		`img-src ${webglAssetSource} data: blob:`,
		`media-src ${webglAssetSource} data: blob:`,
		`font-src ${webglAssetSource} data:`,
		`connect-src ${webglAssetSource} data: blob:`,
		`worker-src ${webglAssetSource} blob:`,
		`child-src ${webglAssetSource} blob:`,
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		`frame-ancestors ${frontendOrigin}`,
	].join('; ');
}
