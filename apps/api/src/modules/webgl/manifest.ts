export interface WebglPublishedObjectManifestEntry {
	objectKey: string;
	sizeBytes: string;
	mimeType: string;
	contentEncoding: string | null;
	etag: string | null;
	checksumSha256: string | null;
}

export interface WebglPublishedObjectManifest {
	version: 1;
	objects: WebglPublishedObjectManifestEntry[];
}

/** Pure metadata validation shared by the control-plane publication plan and workers. */
export function assertWebglPublishedObjectManifest(
	manifest: WebglPublishedObjectManifest,
	publicPrefix: string,
	entryObjectKey: string,
): void {
	if (manifest.version !== 1 || manifest.objects.length === 0) {
		throw new Error('WebGL published object manifest is empty or unsupported');
	}
	const keys = new Set<string>();
	for (const object of manifest.objects) {
		if (!object.objectKey.startsWith(publicPrefix) || object.objectKey === publicPrefix
			|| keys.has(object.objectKey) || !/^\d+$/.test(object.sizeBytes)
			|| BigInt(object.sizeBytes) < 0n || !object.mimeType
			|| !(object.contentEncoding === null || object.contentEncoding === 'br' || object.contentEncoding === 'gzip')
			|| !(object.etag === null || typeof object.etag === 'string')
			|| !(object.checksumSha256 === null || /^[a-f0-9]{64}$/i.test(object.checksumSha256))
			|| (object.etag === null && object.checksumSha256 === null)) {
			throw new Error('WebGL published object manifest is malformed');
		}
		keys.add(object.objectKey);
	}
	if (!keys.has(entryObjectKey)) throw new Error('WebGL published object manifest omits index.html');
}
