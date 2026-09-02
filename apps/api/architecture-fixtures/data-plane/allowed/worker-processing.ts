export async function processVideo(storage: any) {
	const object = await storage.stream('protected', 'source');
	for await (const _chunk of object.body) { /* bounded worker sink */ }
}
