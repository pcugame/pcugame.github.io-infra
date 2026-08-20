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
	return {
		contentType,
		contentEncoding,
		// The deployment UUID is part of every URL, including index.html. A new
		// deployment creates a new prefix, so all published objects are immutable.
		cacheControl: 'public, max-age=31536000, immutable',
	};
}

export function webglContentSecurityPolicy(frontendUrl: string, publicAssetBaseUrl: string): string {
	const frontendOrigin = new URL(frontendUrl).origin;
	const publicAssetOrigin = new URL(publicAssetBaseUrl).origin;
	return [
		"default-src 'none'",
		`script-src ${publicAssetOrigin} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`,
		`style-src ${publicAssetOrigin} 'unsafe-inline'`,
		`img-src ${publicAssetOrigin} data: blob:`,
		`media-src ${publicAssetOrigin} data: blob:`,
		`font-src ${publicAssetOrigin} data:`,
		`connect-src ${publicAssetOrigin} data: blob:`,
		`worker-src ${publicAssetOrigin} blob:`,
		`child-src ${publicAssetOrigin} blob:`,
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		`frame-ancestors ${frontendOrigin}`,
	].join('; ');
}
