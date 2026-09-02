export async function control(storage: any, uploadId: string) {
	await storage.head('protected', 'source');
	await storage.listParts('protected', 'source', uploadId);
	await storage.completeMultipart('protected', 'source', uploadId, []);
	await storage.abortMultipart('protected', 'source', uploadId);
	return storage.presignUploadPart('protected', 'source', uploadId, 1);
}
