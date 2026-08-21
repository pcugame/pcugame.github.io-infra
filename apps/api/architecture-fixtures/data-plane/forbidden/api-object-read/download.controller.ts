export async function download(storage: any) {
	return storage.stream('protected', 'game.zip');
}
