async function completeSession(deps: {
	storage: {
		head(key: string): Promise<{ size: number } | null>;
		stream(key: string): Promise<NodeJS.ReadableStream | null>;
	};
}, key: string): Promise<number> {
	const metadata = await deps.storage.head(key);
	if (!metadata) return 0;
	// A legitimate HEAD operation must not turn the API completion path into an
	// object-body processing role.
	await deps.storage.stream(key);
	return metadata.size;
}

export { completeSession };
