export async function download(deps: {
	storage: { readRange(start: number, end: number): Promise<Buffer> };
}) {
	return { status: 200, body: await deps.storage.readRange(0, 1023) };
}
