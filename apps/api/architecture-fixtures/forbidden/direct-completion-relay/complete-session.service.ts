async function completeDirectSession(deps: {
	storage: { uploadPart(body: NodeJS.ReadableStream): Promise<void> };
}, body: NodeJS.ReadableStream): Promise<void> {
	await deps.storage.uploadPart(body);
}

export { completeDirectSession };
