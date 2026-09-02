export async function reconcileLegacyObject(storage: any, storageKey: string) {
	return storage.head('protected', storageKey);
}
