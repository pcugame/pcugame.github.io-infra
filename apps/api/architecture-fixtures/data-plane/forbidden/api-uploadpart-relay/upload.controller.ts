export async function upload(storage: any, request: any) {
	return storage.uploadPart('protected', 'source', 'upload-id', 1, request.body);
}
