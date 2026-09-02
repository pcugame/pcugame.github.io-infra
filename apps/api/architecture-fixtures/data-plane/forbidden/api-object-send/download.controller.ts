export async function download(storage: any, reply: any) {
	const object = await storage.stream('protected', 'game.zip');
	return reply.send(object.body);
}
