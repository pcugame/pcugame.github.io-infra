export async function relayDirectPart(deps: {
	storage: { uploadPart(body: NodeJS.ReadableStream): Promise<void> };
}, body: NodeJS.ReadableStream): Promise<void> {
	await deps.storage.uploadPart(body);
}
