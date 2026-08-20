export async function publish(deps: {
	storage: { completeMultipart(): Promise<void> };
}): Promise<void> {
	await deps.storage.completeMultipart();
}
