/** Serialize the DB write and cache update together within one API process. */
export function createBanMutationQueue() {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(operation);
		tail = result.catch(() => {});
		return result;
	};
}
